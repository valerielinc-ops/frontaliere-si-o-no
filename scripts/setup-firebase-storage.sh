#!/usr/bin/env bash
# One-time setup of the Firebase Storage default bucket + CORS for publisher CV uploads.
#
# WHY THIS IS A SCRIPT (not done by an agent): provisioning the bucket requires
# project-level IAM the automation SA lacks (serviceusage.services.enable +
# storage.buckets.create + firebasestorage admin). Run this with an OWNER /
# Editor credential.
#
# Auth (pick one before running):
#   gcloud auth login                      # interactive owner account, OR
#   gcloud auth activate-service-account --key-file=<owner-sa>.json
#   gcloud config set project frontaliere-ticino
#
# Then: bash scripts/setup-firebase-storage.sh
#
# Idempotent: safe to re-run. Bucket name + CORS match services/firebase.ts
# (VITE_FIREBASE_STORAGE_BUCKET) and storage.cors.json.
set -euo pipefail

PROJECT="frontaliere-ticino"
BUCKET="frontaliere-ticino.firebasestorage.app"
LOCATION="europe-west6"          # matches the Cloud Functions region (Zurich)
CORS_FILE="$(dirname "$0")/../storage.cors.json"

echo "▶ Enabling APIs…"
gcloud services enable firebasestorage.googleapis.com storage.googleapis.com --project="$PROJECT"

echo "▶ Ensuring bucket gs://$BUCKET exists…"
if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "  bucket already exists."
else
  gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT" --location="$LOCATION" --uniform-bucket-level-access
fi

echo "▶ Linking the bucket to Firebase Storage (addFirebase)…"
# No-op if already linked. Requires the firebasestorage.googleapis.com API + Firebase admin.
TOKEN="$(gcloud auth print-access-token)"
curl -sS -X POST \
  "https://firebasestorage.googleapis.com/v1beta/projects/${PROJECT}/buckets/${BUCKET}:addFirebase" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d '{}' \
  | sed 's/.*/  &/' || echo "  (addFirebase: already linked or returned an error — check above)"

echo "▶ Applying CORS from $CORS_FILE…"
gcloud storage buckets update "gs://$BUCKET" --cors-file="$CORS_FILE" --project="$PROJECT"

echo "▶ Current CORS:"
gcloud storage buckets describe "gs://$BUCKET" --format="value(cors_config)" --project="$PROJECT"

echo "✅ Done. Deploy the rules:  firebase deploy --only storage --project $PROJECT"
echo "   Then a browser upload from https://frontaliereticino.ch (publisher CV) should succeed."
