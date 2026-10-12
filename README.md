# North & Nest

A polished, responsive direct-booking demo for one vacation home in Blue Mountain, Ontario.

## Demo features

- Explore one dedicated property and its amenities
- Browse a responsive photo gallery
- Search dates and guest count
- Complete a booking with a live price breakdown
- View a saved demo confirmation
- Open an owner dashboard and review demo reservations
- Browser-local persistence via `localStorage`

## Replacing the placeholder photos

Open `single.js` and replace the six URLs in `PROPERTY.photos` near the top of the file. The first photo is used as the hero image; the remaining photos populate the gallery and story section.

This is a front-end concept demo. Authentication, payments, server-side inventory locking, messaging, and production data storage would be required before handling real bookings.

## Run locally

Open `index.html` directly, or serve the folder with any static web server.

```powershell
npx serve .
```

## Deploy

The repository includes a GitHub Pages workflow. Any push to `main` publishes the static site.
