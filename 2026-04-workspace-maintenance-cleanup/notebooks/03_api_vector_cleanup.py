# Databricks notebook source
# API-Driven Vector Search Cleanup — removes orphaned indexes (Databricks SDK)

import yaml

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import NotFound

# COMMAND ----------

dbutils.widgets.text("environment", "dev")
env = dbutils.widgets.get("environment")

with open("/Workspace/config/config.yaml") as f:
    config = yaml.safe_load(f)[env]

if not config.get("vector_cleanup", False):
    dbutils.notebook.exit(f"Vector cleanup disabled for {env}")

dry_run = config.get("dry_run", True)

# COMMAND ----------

%run ./00_cleanup_logger

w = WorkspaceClient()
logger = CleanupLogger(spark)

# COMMAND ----------

deleted, skipped = 0, 0

for ep in w.vector_search_endpoints.list_endpoints():
    for mini in w.vector_search_indexes.list_indexes(endpoint_name=ep.name):
        idx_name = mini.name

        # Fetch full index to read the delta-sync source table.
        index = w.vector_search_indexes.get_index(index_name=idx_name)
        creator = getattr(index, "creator", None) or "unknown"
        source_table = (index.delta_sync_index_spec.source_table
                        if index.delta_sync_index_spec else None)

        # "Orphaned" == a delta-sync index whose source table no longer exists.
        # Direct-access indexes have no source table, so they are never treated
        # as orphaned here. A still-provisioning index is NOT a delete candidate.
        if not source_table:
            logger.log(
                environment=env, resource_type="vector_index",
                resource_id=idx_name, resource_name=idx_name, owner=creator,
                action="SKIPPED",
                reason="No delta-sync source table (direct-access index)",
                dry_run=dry_run, details={"endpoint": ep.name},
            )
            skipped += 1
            continue

        source_exists = w.tables.exists(full_name=source_table).table_exists

        if not source_exists:
            if not dry_run:
                w.vector_search_indexes.delete_index(index_name=idx_name)
            logger.log(
                environment=env, resource_type="vector_index",
                resource_id=idx_name, resource_name=idx_name, owner=creator,
                action="DELETED" if not dry_run else "FLAGGED",
                reason=f"Orphaned — source table {source_table} no longer exists",
                dry_run=dry_run,
                details={"endpoint": ep.name, "source_table": source_table},
            )
            deleted += 1
        else:
            logger.log(
                environment=env, resource_type="vector_index",
                resource_id=idx_name, resource_name=idx_name, owner=creator,
                action="SKIPPED",
                reason="Active — source table exists",
                dry_run=dry_run,
                details={"endpoint": ep.name, "source_table": source_table},
            )
            skipped += 1

flushed = logger.flush()
print(f"Vector Indexes — {'[DRY RUN] ' if dry_run else ''}Deleted: {deleted}, "
      f"Skipped: {skipped}, Logged: {flushed}")
