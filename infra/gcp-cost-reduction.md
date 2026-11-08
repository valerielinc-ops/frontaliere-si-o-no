# Cost guardrails and retention

Project: `frontaliere-ticino`; function and bucket region: `europe-west6`.

## Cloud Run and Firebase Storage monitoring

`scripts/monitor-gcp-costs.mjs` reads rolling 24-hour Cloud Monitoring totals.
The Cloud Run request driver groups `run.googleapis.com/request_count` by
service in `europe-west6`; its 200,000/day threshold is above the October
baseline (~70,000/day) and the current 115,000–140,000/day range. The billable
instance-time guard is 20,000 seconds/day against a pre-incident baseline of
about 10,000; this catches the 39,323-second day that stayed below the old
40,000-second limit. The Firebase Storage driver reads
`storage.googleapis.com/network/sent_bytes_count` for
`frontaliere-ticino.firebasestorage.app`, with a 2 GiB/day threshold against
about 1.2 GiB/day (~35 GiB per 30 days). The metric counts all bytes sent by
the bucket, not only billable internet egress; it cannot separate internet
traffic from same-location Google Cloud reads, which are free ([Cloud Storage
bandwidth metric](https://docs.cloud.google.com/storage/docs/bandwidth-usage),
[network pricing](https://cloud.google.com/storage/pricing#network)). The CHF
column is therefore directional for this driver, not an invoice attribution.

The bucket holds about 213 MB, mostly `assisted-application-uploads/`, while
the observed ~160 `ReadObject` requests/day average about 7 MB each. The
GitHub Actions assisted-application runner is an external reader:
`scripts/assisted-application/agent.mjs` downloads the CV for a draft, or for
a submit only when the candidate selected the original CV. A tailored or
in-place CV submit skips the original upload; the selected file is held in
memory and reused for that run. Cloud Functions in `europe-west6` also read
objects for validation and review; reads from Google Cloud services in the
same location are free
([Cloud Storage network pricing](https://cloud.google.com/storage/pricing#network)).
Signed URLs are created by authenticated, explicit download/review paths, not
fetched automatically. No cross-run cache is used for raw CVs because it would
persist personal documents outside their current retention path. The assisted
application document-recheck endpoint uses generation/hash metadata to return
`unchanged` without downloading an unchanged document.

## Cloud Functions v2 source bucket

The bucket `gcf-v2-sources-957502085858-europe-west6` initially had Object
Versioning enabled, a Delete rule for `isLive=false` and
`numNewerVersions=3`, a seven-day soft-delete window, and metageneration 1.
A read-only check found 114 functions in `europe-west6`; all had
`allTrafficOnLatestRevision=true`, and all 114 build source references
matched the current live object generation. No function referenced a
noncurrent or missing source generation. Content-wise, changing the rule to
`numNewerVersions=1` would still leave each live generation outside the
rule and the soft-delete window intact. A shorter soft-delete window would
require disabling that recovery period and was not attempted
([build process](https://docs.cloud.google.com/functions/docs/building),
[lifecycle conditions](https://docs.cloud.google.com/storage/docs/lifecycle),
[soft-delete policy](https://docs.cloud.google.com/storage/docs/soft-delete)).

The exact trial rule is retained as
`infra/gcf-v2-sources-lifecycle-experiment.json`. It was applied only after
a before-description with this command:

```sh
gcloud storage buckets update \
  gs://gcf-v2-sources-957502085858-europe-west6 \
  --project=frontaliere-ticino \
  --lifecycle-file=infra/gcf-v2-sources-lifecycle-experiment.json
```

The read-only description used before and after each trial was:

```sh
gcloud storage buckets describe \
  gs://gcf-v2-sources-957502085858-europe-west6 \
  --project=frontaliere-ticino \
  --format='json(name,location,versioning_enabled,lifecycle_config,soft_delete_policy,metageneration)'
```

The first describe returned metageneration 1, `numNewerVersions=3`,
versioning enabled, and soft delete `604800` seconds. The first update
returned metageneration 2 and `numNewerVersions=1`; a subsequent audit event
from `service-957502085858@gcf-admin-robot.iam.gserviceaccount.com` restored
`numNewerVersions=3` at metageneration 3. After the Cloud Functions deploy
completed, a second before-description again showed 3. The same exact update
briefly set 1 at metageneration 4, then the GCF service agent restored 3 at
`2026-11-08T20:31:02Z` (metageneration 5). The final describe confirmed
`numNewerVersions=3`, versioning enabled, and the seven-day soft-delete
window unchanged.

Conclusion: reducing the count is safe for the currently referenced function
sources, but GCF manages this bucket's lifecycle and restores its default
rule. Do not keep reapplying the override or disable soft delete; the live
policy remains the service-managed `numNewerVersions=3`. No objects were
deleted manually. The inventory during the first trial found 114 live versions
(~0.20 GiB), 137 active noncurrent versions (~0.23 GiB), and 11,925 already
soft-deleted objects (~19.77 GiB), about 20.20 GiB total; the reported 32 GiB
was not confirmed. There is no persistent storage reduction from this trial.

## Firestore retention candidates

The database-level metric currently grows about 1.33 GiB/week, but it does not
attribute storage by collection. A read-only Firestore REST census on
2026-11-08 found:

| Collection | Current documents | New in 7 days | Mean REST field payload | Estimated new payload/week | Retention |
|---|---:|---:|---:|---:|---|
| `application_intents` | 4,038 | 766 | 1,775 B | ~1.3 MiB | Existing daily purge deletes records at their explicit 90-day expiry and deletes the corresponding delivery record in the same cleanup. Keep this cascade for legacy delivery records without an expiry field. |
| `application_intent_reminder_deliveries` | 2,437 | 487 | 447 B | ~0.2 MiB | Ephemeral idempotency/delivery ledger. New claims copy the parent intent's existing `expiresAt` (90 days); Firestore TTL is enabled for this field. |

Payload estimates use the UTF-8 size of Firestore REST `fields` JSON and do
not include indexes, document metadata, or storage-engine overhead. They show
these two collections are not a plausible source of the database's 1.33
GiB/week increase; the exact collection-level growth remains unmeasured. The
TTL applies only to `application_intent_reminder_deliveries`, which is an
ephemeral claim ledger. The parent `application_intents` collection keeps its
existing scheduled cascade because legacy delivery records do not yet all have
their own `expiresAt`. TTL does not apply to applications, orders, or other
business records; old delivery documents without `expiresAt` remain covered by
the current parent-intent retention purge. Existing TTL policies remain on
`job_email_ranking_stats.expires_at`, `job_email_ranking_events.expires_at`,
`job_email_ranking_deliveries.expires_at`, and `job_email_affinity.expires_at`;
this change does not alter them. The shared `events` collection-group name
contains newsletter delivery history and business/audit events, so it has no
single safe retention window and receives no blanket TTL. The 1.33 GiB/week
database-level increase is not attributed to a collection by available
Firestore metrics; the two measured intent collections account for only about
1.5 MiB/week of new REST field payload, before index/storage overhead.
The same index check found an existing `collectionGroup('events').where('alert_id', ...)`
query without `COLLECTION_GROUP` coverage. Its required single-field
collection and collection-group index is now declared; its storage effect was
not measured. `events.message_id` remains collection-group indexed and is not
an index-exemption candidate.

The existing Firestore index deployment workflows apply the field override
after merge. Verify the live TTL configuration with:

```sh
gcloud firestore indexes fields describe expiresAt \
  --collection-group=application_intent_reminder_deliveries \
  --database='(default)' \
  --project=frontaliere-ticino \
  --format=json
```

After merge, the Firestore indexes and Cloud Functions deploy workflows both
completed successfully. The live `expiresAt` description returned
`ttlConfig.state=ACTIVE`; the initial list before deploy showed no policy for
this field. The
`events.alert_id` field description returned both `COLLECTION` and
`COLLECTION_GROUP` indexes in `READY` state. The production TTL applies only to
the ephemeral delivery-claim collection described above; no TTL was added to
business collections.
