# CHARCOAL MARKETPLACE — Railway Single-URL Build

## Architecture

The project is now designed for:

    Pi Browser
        |
        v
    Railway HTTPS URL
        |
        +-- Static frontend: HTML/CSS/JS
        |
        +-- /api/* backend routes
        |
        +-- /uploads/* product images
        |
        +-- Railway MySQL

Frontend and backend use the same origin. Frontend API calls use `/api`.

## Important deployment variables

Set these in Railway Variables. Do NOT commit a real `.env` file.

Required:

- DB_HOST
- DB_PORT
- DB_USER
- DB_PASSWORD
- DB_NAME
- JWT_SECRET
- PI_API_KEY
- PI_SUPER_ADMIN_USERNAME

Recommended:

- NODE_ENV=production
- PORT is supplied automatically by Railway
- PLATFORM_FEE_PERCENT=0

Optional:

- FRONTEND_ORIGINS
- BASE_URL
- SERVER_URL
- CLIENT_URL

For the single Railway URL, FRONTEND_ORIGINS can remain empty. If you keep it configured, remove old Vercel/Render origins and use the new Railway origin.

## Database

Run `schema.sql` against the Railway MySQL database.

WARNING: the supplied schema contains DROP TABLE statements. It is intended for a fresh/new database. Back up any existing production data before running it.

The fixed schema includes the `products.location` column required by the current frontend.

## Pi Developer Portal

After moving from Vercel/Render to Railway, update the Pi app URL in the Pi Developer Portal to the new Railway HTTPS URL.

The normal Pi Testnet/Developer Portal app must NOT force:

    sandbox: true

The frontend now enables sandbox mode only when it is actually running on `sandbox.minepi.com` or when `PI_SANDBOX=true` is deliberately set in local storage.

## Deployment

1. Upload/push this project to the Railway service.
2. Confirm Railway runs:
   `npm start`
3. Set the Railway environment variables.
4. Run the fixed `schema.sql` on the Railway MySQL database.
5. Deploy/redeploy.
6. Open:
   `/api/health`
7. Open:
   `/api/health/database`
8. Open:
   `/api/health/routes`
9. Open the app root URL in Pi Browser.
10. Test Pi login from Profile.
11. Test vendor registration/approval.
12. Test product creation/approval.
13. Test checkout/payment.

## Security

The original `.env` and `validation-key.txt` were intentionally not included in this cleaned deployment package.

Never upload or commit a real `.env` containing PI_API_KEY, DB_PASSWORD, or JWT_SECRET.
