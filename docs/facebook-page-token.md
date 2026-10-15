# Facebook Page Access Token — Setup Guide

This document explains how to obtain a **long-lived Page Access Token** for auto-posting articles to the Frontaliere Ticino Facebook Page.

## Prerequisites

- A **Facebook Page** for Frontaliere Ticino
- A **Facebook App** (ID: `891036063797338`) registered at [developers.facebook.com](https://developers.facebook.com)
- Admin access to both the Page and the App

---

## Step 1: Get a Short-Lived User Token

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select your app (`891036063797338`) from the **Facebook App** dropdown
3. Click **Generate Access Token**
4. Grant these permissions:
   - `pages_manage_posts` — required to publish posts
   - `pages_read_engagement` — required to read page info
5. Copy the generated **User Access Token** (valid ~1 hour)

## Step 2: Exchange for a Long-Lived User Token

Replace `{short-lived-token}` with the token from Step 1:

```bash
curl -s "https://graph.facebook.com/v21.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=891036063797338&\
client_secret={APP_SECRET}&\
fb_exchange_token={short-lived-token}" | jq .
```

Response:
```json
{
  "access_token": "EAAM...",
  "token_type": "bearer",
  "expires_in": 5184000
}
```

This token is valid for ~60 days.

## Step 3: Get the Page Access Token

Use the long-lived user token to fetch the Page token:

```bash
curl -s "https://graph.facebook.com/v21.0/me/accounts?\
access_token={long-lived-user-token}" | jq .
```

Response:
```json
{
  "data": [
    {
      "access_token": "EAAM...PAGE_TOKEN",
      "category": "Internet Company",
      "name": "Frontaliere Ticino",
      "id": "PAGE_ID_HERE"
    }
  ]
}
```

The **Page Access Token** obtained this way is **long-lived** (~60 days) or **permanent** if the user granted `pages_manage_posts` to the app in the App Dashboard settings.

> **Tip**: To get a **never-expiring** Page token, make sure the App is in **Live** mode and the user who generated the token has a role on the App (Admin/Developer).

## Step 4: Verify the Token

```bash
curl -s "https://graph.facebook.com/v21.0/debug_token?\
input_token={page-access-token}&\
access_token=891036063797338|{APP_SECRET}" | jq .
```

Check that:
- `is_valid` is `true`
- `expires_at` is `0` (never expires) or a far-future timestamp
- `scopes` includes `pages_manage_posts`

## Step 5: Save as GitHub Secrets

In the repository **Settings → Secrets and variables → Actions**, add:

| Secret Name | Value |
|---|---|
| `FB_PAGE_ACCESS_TOKEN` | The Page Access Token from Step 3 |
| `FB_PAGE_ID` | The Page ID from Step 3 (`id` field) |

## Token Renewal

If the token expires (you'll see `Error validating access token` in workflow logs):

1. Repeat Steps 1–3
2. Update the `FB_PAGE_ACCESS_TOKEN` secret in GitHub

To avoid renewal, ensure:
- The Facebook App is in **Live** mode
- The app has **Advanced Access** for `pages_manage_posts`
- The token-generating user is an Admin of both the App and the Page

## Testing Locally

```bash
FB_PAGE_ACCESS_TOKEN=your_token FB_PAGE_ID=your_page_id \
  node scripts/post-to-facebook.mjs \
    "test-article" \
    "https://frontaliereticino.ch/articoli-frontaliere/test" \
    "Test Article Title" \
    "Test article description" \
    "pratico" \
    --dry-run
```

Remove `--dry-run` to actually post.
