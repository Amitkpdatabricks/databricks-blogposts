# Databricks notebook source
# API-Driven Dashboard Cleanup — trashes stale or already-trashed dashboards (Databricks SDK)

import yaml
from datetime import datetime, timezone

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.dashboards import LifecycleState

# COMMAND ----------

dbutils.widgets.text("environment", "dev")
env = dbutils.widgets.get("environment")

with open("/Workspace/config/config.yaml") as f:
    config = yaml.safe_load(f)[env]
with open("/Workspace/config/thresholds.yaml") as f:
    thresholds = yaml.safe_load(f)

if not config.get("dashboard_cleanup", False):
    dbutils.notebook.exit(f"Dashboard cleanup disabled for {env}")

dry_run = config.get("dry_run", True)
inactive_days = thresholds.get("dashboard_inactive_days", 60)

# COMMAND ----------

%run ./00_cleanup_logger

w = WorkspaceClient()
logger = CleanupLogger(spark)
now = datetime.now(timezone.utc)

# COMMAND ----------

deleted, skipped = 0, 0

for summary in w.lakeview.list():
    # list() does not populate update_time — fetch the full dashboard to read it.
    dash = w.lakeview.get(dashboard_id=summary.dashboard_id)
    dash_id = dash.dashboard_id
    dash_name = dash.display_name or "unnamed"
    creator = getattr(dash, "creator_user_name", None) or "unknown"
    already_trashed = dash.lifecycle_state == LifecycleState.TRASHED

    if dash.update_time:
        last_updated = datetime.fromisoformat(dash.update_time.replace("Z", "+00:00"))
        days_stale = (now - last_updated).days
    else:
        last_updated, days_stale = None, None

    is_stale = days_stale is not None and days_stale > inactive_days

    if is_stale or already_trashed:
        # trash() moves the dashboard to trash (recoverable), not a permanent delete.
        if not dry_run and not already_trashed:
            w.lakeview.trash(dashboard_id=dash_id)
        logger.log(
            environment=env, resource_type="dashboard",
            resource_id=dash_id, resource_name=dash_name, owner=creator,
            action="DELETED" if not dry_run else "FLAGGED",
            reason="Already trashed" if already_trashed else f"Stale {days_stale} days",
            dry_run=dry_run,
            details={"last_updated": last_updated.isoformat() if last_updated else None,
                     "state": str(dash.lifecycle_state)},
        )
        deleted += 1
    else:
        logger.log(
            environment=env, resource_type="dashboard",
            resource_id=dash_id, resource_name=dash_name, owner=creator,
            action="SKIPPED",
            reason=f"Active — updated {days_stale} days ago",
            dry_run=dry_run,
        )
        skipped += 1

flushed = logger.flush()
print(f"Dashboards — {'[DRY RUN] ' if dry_run else ''}Deleted: {deleted}, "
      f"Skipped: {skipped}, Logged: {flushed}")
