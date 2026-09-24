# Databricks notebook source
# API-Driven Job Cleanup — deletes jobs inactive beyond threshold (Databricks SDK)

import yaml
from datetime import datetime, timezone

from databricks.sdk import WorkspaceClient

# COMMAND ----------

dbutils.widgets.text("environment", "dev")
env = dbutils.widgets.get("environment")

with open("/Workspace/config/config.yaml") as f:
    config = yaml.safe_load(f)[env]
with open("/Workspace/config/thresholds.yaml") as f:
    thresholds = yaml.safe_load(f)

if not config.get("job_cleanup", False):
    dbutils.notebook.exit(f"Job cleanup disabled for {env}")

dry_run = config.get("dry_run", True)
inactive_days = thresholds.get("job_inactive_days", 90)

# Jobs that have never run: skip by default (safer than deleting; flag for manual
# review). Set delete_never_run: true in thresholds.yaml to treat them as candidates.
delete_never_run = thresholds.get("delete_never_run", False)

# COMMAND ----------

# Setup
%run ./00_cleanup_logger

# WorkspaceClient() authenticates automatically from the notebook context —
# no manual host, token, or headers required, so the same code runs unchanged
# in every target workspace the bundle is deployed to.
w = WorkspaceClient()
logger = CleanupLogger(spark)
now = datetime.now(timezone.utc)

# COMMAND ----------

deleted, skipped = 0, 0

for job in w.jobs.list(expand_tasks=False):
    job_id = job.job_id
    job_name = job.settings.name if job.settings else "unnamed"
    creator = job.creator_user_name or "unknown"

    # Most recent run (list_runs returns newest first)
    runs = list(w.jobs.list_runs(job_id=job_id, limit=1))
    last_start_ms = runs[0].start_time if runs else None

    # Guard: a job that has never run has no start time.
    if last_start_ms is None:
        if delete_never_run:
            if not dry_run:
                w.jobs.delete(job_id=job_id)
            logger.log(
                environment=env, resource_type="job",
                resource_id=job_id, resource_name=job_name, owner=creator,
                action="DELETED" if not dry_run else "FLAGGED",
                reason="Never run",
                dry_run=dry_run, details={"last_run": None, "total_runs": 0},
            )
            deleted += 1
        else:
            logger.log(
                environment=env, resource_type="job",
                resource_id=job_id, resource_name=job_name, owner=creator,
                action="SKIPPED",
                reason="Never run — manual review required",
                dry_run=dry_run,
            )
            skipped += 1
        continue

    last_run = datetime.fromtimestamp(last_start_ms / 1000, tz=timezone.utc)
    days_idle = (now - last_run).days

    # Branch on the idle count directly (both sides are timezone-aware).
    if days_idle > inactive_days:
        if not dry_run:
            w.jobs.delete(job_id=job_id)
        logger.log(
            environment=env, resource_type="job",
            resource_id=job_id, resource_name=job_name, owner=creator,
            action="DELETED" if not dry_run else "FLAGGED",
            reason=f"Inactive {days_idle} days (threshold: {inactive_days})",
            dry_run=dry_run,
            details={"last_run": last_run.isoformat(), "total_runs": len(runs)},
        )
        deleted += 1
    else:
        logger.log(
            environment=env, resource_type="job",
            resource_id=job_id, resource_name=job_name, owner=creator,
            action="SKIPPED",
            reason=f"Active — last run {days_idle} days ago",
            dry_run=dry_run,
        )
        skipped += 1

flushed = logger.flush()
print(f"Jobs — {'[DRY RUN] ' if dry_run else ''}Deleted: {deleted}, "
      f"Skipped: {skipped}, Logged: {flushed}")
