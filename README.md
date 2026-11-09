# Our Family Tree

A shared family tree website. One person starts a tree with a name and password; relatives join with the same name and password (or an invite link) and add people together. Tap anyone to see their parents, partners, children and siblings.

## How it's built
- Plain HTML/CSS/JS, hosted free on GitHub Pages.
- Data lives in Firebase Firestore, under `trees/<hash of name+password>/people`.
- `firestore.rules` stops anyone from listing trees, so a tree can only be opened by someone who knows its name and password (or has its invite link).

## Setup
1. Paste your Firebase web config into `firebase-config.js`.
2. In Firebase → Firestore Database → Rules, paste the contents of `firestore.rules` and publish.
3. In GitHub → Settings → Pages, set Source to "Deploy from a branch", branch `main`, folder `/ (root)`.
