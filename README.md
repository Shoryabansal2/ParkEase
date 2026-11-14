# ParkEase

A college parking-management project using Next.js/React, Tailwind CSS, Node.js/Express REST APIs, MySQL, and Leaflet/OpenStreetMap. The default local adapter persists data in `backend/data/demo.json`, so the project can run without a MySQL installation. Payments and gate operations are simulated.

## Run locally

Use Node.js 20.9 or newer.

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:3000. The Express API listens at http://127.0.0.1:5001; Next.js forwards `/api/*` requests to it. `API_URL` can override the backend destination. `npm run dev` starts both applications with file watching.

The demo adapter preserves users, facilities, bays, bookings, memberships, receipts, support requests, EV watches, and account audits. Missing demo locations are merged without resetting existing bookings, rates, or listing status. Keep `backend/data/` private; it is ignored by Git. Without an explicit `JWT_SECRET`, demo sessions use a randomly generated signing key stored locally at `backend/data/session.key`, so development-server restarts do not sign everyone out. MySQL mode still requires an explicit `JWT_SECRET`.

## MySQL setup

1. Start a local MySQL server.
2. Copy `backend/.env.example` to `backend/.env`.
3. Set `DB_DRIVER=mysql`, database credentials, and a long random `JWT_SECRET`.
4. Run `npm run db:setup` from the project root.
5. Run `npm run dev`. The footer and `/api/health` report the storage adapter.

```dotenv
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-local-password
DB_NAME=parkease
JWT_SECRET=replace-with-a-long-random-secret
DEMO_MODE=true
```

`backend/src/schema.sql` defines the relational tables and foreign keys. Setup creates the database and adds missing columns/tables without deleting existing data. Rerun it on existing installations to add account status/session version, `auditLogs`, payment records, membership fields, and booking `convenienceFee`. The configured database user needs schema creation permission. MySQL connection failures stop startup instead of silently switching adapters. Slot transactions lock the bay before checking overlaps and recording payments/reservations.

MySQL migrations require a configured server; automated integration tests use isolated demo stores.

## Sign-in and demonstration

Seeded local accounts use password **ParkEase@123**:

| Role | Email |
| --- | --- |
| Driver | driver@parkease.com |
| Operator | operator@parkease.com |
| Administrator | admin@parkease.com |

Administrators use the ordinary email/password sign-in form. There is no public admin selector, one-click admin demo login, or administrator registration. Account role is determined after credentials are verified. Driver/Operator selection is offered during registration. The bottom demo switcher provides Driver and Operator access only; `POST /api/auth/demo` rejects ADMIN.

1. Sign in as a driver, or use the Driver demo button.
2. Choose destination, date, arrival time, duration, and vehicle type. Map markers show base facility rates; bike rates are half the base rate.
3. Select a facility and an available bay. Review the time window, vehicle registration, price, and convenience fee.
4. Continue to payment, choose UPI/card, and enter correctly formatted **test** details. Use the test-details helper if needed. No reservation exists until the simulated payment and final availability check succeed.
5. Save the QR pass from the confirmation or My bookings. Its QR encodes the booking ID.
6. Extend a confirmed/active reservation when more time is available. Only the additional parking charge is due; the bay and QR booking ID stay the same.
7. Switch to Operator to look up booking IDs and check vehicles in/out. Operators can update rates and maintenance for their facilities.
8. Sign out and sign in with the admin credentials to manage the platform.

Set `DEMO_MODE=false` to disable one-click Driver/Operator demo sign-in and enforce real check-in timing. Demo membership activation is disabled outside demo mode until a real provider is configured. Provision production administrator credentials separately; the seeded credentials are intended for this local college demo.

## Homepage and location network

The demo has 12 approved facilities across Delhi NCR plus a pending Saket facility, with 468 seeded bays. Added areas include India Gate, Khan Market, Karol Bagh, Nehru Place, Aerocity, Rajouri Garden, Noida Sector 18, and Gurugram Cyber Hub. These names, ratings, locations, and availability are illustrative demo inventory rather than verified live services. Existing MySQL installations receive missing seed entries through `npm run db:setup`.

The homepage includes a photographic hero, responsive navigation, destination search, car/bike/EV filters, rate/rating sorting, a map, facility cards, How ParkEase Works, a ₹999/month VIP banner, operator entry points, clearly labelled sample reviews, and a full footer. `/privacy`, `/terms`, and `/sitemap` are public pages. Contact details are labelled placeholders; social icons explain that profiles are not configured. No Razorpay, indoor-navigation, horn, charging, camera-scanning, or physical-barrier integration is claimed.

Operator registration and sign-in are available at `/operator/register` and `/operator/sign-in`. New operators start with an empty dashboard and can submit facility name/address, coordinates, rate, and amenities. Each submission gets 36 demo bays and remains PENDING until an administrator approves it. The API derives facility ownership from the session; an operator cannot self-approve or manage another owner's facilities.

## Operator workspace

The business dashboard has separate **Your facilities** and **Reservations** tabs with server pagination (5/10/25/50 rows), search, status filters, and sorting. Facilities show total bays, checked-in vehicles, maintenance bays, hourly rate, amenities, and approval state. Open **Manage** to edit the hourly rate or manage bays. Operators cannot approve their own listing.

Reservations can be filtered by facility, vehicle type, status, and local arrival-date range. Details show the driver, bay, pricing/discount/fee breakdown, payment status, check-in/out times, QR pass, and allowed gate actions. Booking-ID lookup works directly against the owned record, regardless of the selected table page. Summary/table data refresh every 15 seconds; background refresh preserves the table and open detail panel.

Bay management has independent Car/Bike/EV selection and matching icons. Inventory includes pending/suspended owned facilities; public discovery still requires approval. Checked-in vehicles and future reservations protect their bays from maintenance. An overdue active visit remains protected until checkout. Bike icons also appear in driver bay selection and booking cards; EV bays use the charging icon.

New authenticated endpoints: `GET /api/operator/overview`, `/api/operator/facility-options`, `/api/operator/manage/facilities`, `/api/operator/manage/reservations`, `/api/operator/reservations/:id`, and `/api/manage/facilities/:id/slots?vehicleType=CAR|BIKE|EV`. Operator filtering is enforced before pagination, aggregation, and lookup. Foreign facilities/reservations are inaccessible. Shared integration tests cover pagination over 250 reservations, combined filters, ownership boundaries, and maintenance protection. No schema migration is needed for these workspace changes.

## Reservations, pricing, and checkout

- Date-specific availability and overlap checks are enforced by the API and transaction, including concurrent booking/extension attempts. Pending, suspended, blocked, or incompatible bays cannot be reserved.
- Search and bay selection share a duration slider and typed entry. Examples: `30`, `30 min`, `90 min`, `1.5h`, `1h 30m`. Parking runs from 15 minutes to 24 hours with prorated prices rounded to two decimal places.
- Changing date, arrival, or duration clears the bay and refreshes availability. The calendar greys out/disables days outside the tier's exact rolling booking window; last-day arrival times are clamped too. Tier changes also clamp an out-of-range selection.
- **Standard convenience fee: ₹10 per reservation. Premium VIP: waived.** The server calculates and stores this separately from parking charges and discounts. Existing bookings keep their original prices; missing fees are treated as zero.
- Extensions add 15 minutes to 12 hours within the 24-hour total limit, preserve the agreed effective parking rate, and reject stale/duplicate or conflicting changes. The original convenience fee is charged once and is not scaled or added again.
- Extension review prominently displays **Pay now for this extension** and shows combined booking value separately as already-paid plus additional payment.
- Cancellation releases the bay and voids the full simulated payment, including any convenience fee, when permitted by the booking's cancellation policy.
- Passwords have accessible Show/Hide controls in sign-in and registration.

Checkout has editable UPI/card fields. UPI requires a valid handle format. Cards require a valid Luhn checksum, cardholder name, unexpired MM/YY expiry, and a 3–4 digit security code. Both browser and API validate format; a valid format does not represent real bank authorization.

Test examples:

| Method | Details |
| --- | --- |
| UPI | `parkease.demo@upi` |
| Card | `4242 4242 4242 4242`, name `ParkEase Demo`, expiry `12/39`, CVV `123` |

Use test details only. Raw instrument fields are validated and discarded; they are never stored with users or receipts. No PIN or OTP is requested. Receipts store method, amount, purpose, booking association, status, and timestamp. Payments are simulated: no real money changes hands.

Checkout sends `{ payment: { method: "UPI" | "CARD", outcome: "SUCCESS" | "FAILED", expectedAmount, details } }` alongside the booking, extension, or membership request. The API calculates the authoritative amount and rejects stale totals. Payment recording and booking mutation share a transaction. Failed/invalid payments create no booking, membership, extension, or receipt. **Test a failed payment** demonstrates recovery.

## Driver memberships

Premium VIP costs **₹999 per calendar month** with simulated checkout and no automatic renewal. Billing dates clamp to the last day of shorter months (January 31 → February 28). Existing memberships retain their expiry and are not retroactively charged.

| Benefit | Standard | Premium VIP |
| --- | --- | --- |
| Advance booking | Up to 24 hours | Up to 7 days |
| Bay discount | 0% | 20% automatically |
| Convenience fee | ₹10 per reservation | Waived |
| Priority EV bays | General bays only | VIP allocation and in-app availability alerts |
| Gate pass | Standard optical QR | Express-marked demo pass |
| Free cancellation | Until 2 hours before arrival | Until 30 minutes before arrival |
| Support | Standard request queue | Priority concierge request queue |
| Savings tracker | Booking history | VIP savings across bookings/extensions |

Priority EV bays C-11/C-12 are reserved from general allocation at EV-enabled facilities. VIP drivers can select **Watch EV availability**; Membership refreshes alerts every 15 seconds while open. An alert does not hold a space or displace another reservation. The backend checks availability when booking. Existing reservations keep their agreed pricing and cancellation policy after membership expires.

Express hardware, fast charging, email delivery, and live 24/7 concierge staffing are simulated. Support requests persist in the local admin queue. After a free-cancellation deadline, contact support; the demo does not invent late charges.

## Admin operations console

The console has separate **Reservations, Facilities, People, Support, and Account audit** views. Tables use server-paginated responses with search, sorting, filters, row limits (5/10/25/50), and page navigation. Reservation filters include arrival dates and driver; date filters use the browser timezone. Detail panels keep actions and long descriptions out of the table.

- Reservations: inspect prices, convenience fees, membership discounts, payment state, QR pass, arrival/departure, and check-in history; check in/out or confirm cancellation.
- Facilities: inspect ownership and amenities, edit hourly rates, approve/reject submissions, and suspend/restore listings.
- People: search name/email/vehicle, filter role/access, inspect activity counts, edit profile/email/vehicle, change Driver/Operator role, and suspend/reactivate access.
- Support: inspect requests and resolve/reopen them.
- Account audit: inspect actor, target, old/new values, timestamp, and mandatory reason for each account change. Audit entries are retained and cannot be edited/deleted in the UI.

Suspension blocks existing sessions and new sign-ins. Restoring access requires a fresh login; revoked tokens remain invalid. Suspended operators disappear from discovery while their facilities and bookings are retained. Staff can continue handling existing reservations. Drivers with upcoming active/confirmed reservations cannot change role; operators owning facilities must remain operators. Administrator role/access is protected in this interface. Email uniqueness, role rules, and permissions are server-enforced.

Metrics summarize all records while tables return only the requested page. Refresh reloads the current page and metrics; mutations refresh automatically. Driver/operator booking activity refreshes every 15 seconds. The demo adapter filters in memory; large production datasets should move these queries into indexed SQL. Integration coverage includes pagination over 250 reservations.

## REST API

All protected requests use `Authorization: Bearer <token>`. Password hashes and session versions are not returned in public user responses.

| Method | Endpoint | Purpose/access |
| --- | --- | --- |
| GET | `/api/health` | Storage/demo status |
| POST | `/api/auth/register`, `/api/auth/login` | Driver/Operator registration; credential sign-in |
| POST | `/api/auth/demo` | Driver/Operator only, demo mode |
| GET / PUT | `/api/auth/me`, `/api/auth/profile` | Session/profile |
| GET | `/api/facilities`, `/api/facilities/:id/slots` | Time-window availability |
| POST / GET | `/api/bookings` | Driver checkout; own/assigned/admin history |
| POST | `/api/bookings/:id/extend` | Owner/admin; hours, expectedEndAt, payment |
| POST | `/api/bookings/:id/cancel` | Owner/admin |
| POST | `/api/bookings/:id/check-in`, `/check-out` | Assigned operator/admin |
| GET / POST | `/api/manage/facilities` | Own facilities; operator submission |
| PATCH | `/api/manage/facilities/:id` | Own rate; admin listing status/rate |
| PATCH | `/api/manage/slots/:id` | Assigned operator/admin maintenance |
| GET / POST | `/api/membership`, `/api/membership/activate` | Membership overview/paid activation |
| POST | `/api/membership/ev-alerts`, `/api/support` | Driver alerts/support |
| GET / PATCH | `/api/admin/support`, `/api/admin/support/:id` | Admin support |
| GET | `/api/admin/overview` | Aggregate admin metrics |
| GET | `/api/admin/manage/:resource` | Paginated reservations/facilities/people/support/audit |
| PATCH | `/api/admin/users/:id` | Admin account update; mandatory reason |
| GET | `/api/admin/users` | Legacy admin user summary endpoint |

Management lists accept `page`, `pageSize` (5–50), `q`, `status`, `role`, and `sort`. Reservations also accept `from`, `to`, `timezoneOffset`, and `userId`. Responses contain `items`, `total`, `page`, `pages`, and `pageSize`. Dates in storage/API use ISO 8601 instants; display uses the browser's local timezone.

## Parking listing photos

Demo cards use locally bundled Pexels sample photographs, with source links and a “Sample photo” label; they do not depict the named facilities. See `frontend/public/images/parking/CREDITS.md` for sources and license links. Operator photographs replace the sample image on public listing cards.

Operators can upload an optional photo while listing a facility, or use **Your facilities → Manage → Parking photo → Save facility changes** to replace/remove an existing photo. JPG, PNG, and WebP files are supported up to 2 MB, at least 320 × 200 pixels, and at most 20 megapixels. The form previews the photo and checks file type, size, and dimensions. The backend verifies decoded image format/content, rejects animation, strips metadata, and saves an optimized WebP no larger than 1200 × 900. Filenames are random, and only the listing owner or an administrator can change its photo. New listings still require administrator approval.

Uploads are stored in ignored `backend/data/uploads/facilities/`, referenced by `facilities.photoUrl`, and served at `/api/uploads/facilities/:filename.webp`. Uploaded photos are public images; no original filename or base64 image is stored in the database. Replaced image files are retained; periodically remove unreferenced uploads if needed. Back up this upload folder together with your database. Existing MySQL installations need `npm run db:setup` to add the nullable `photoUrl` column. Photo handling uses the Sharp backend dependency. Standard API bodies retain their 20 KB limit; authenticated listing create/update requests allow 3 MB to accommodate base64 image transport.

## Parking discovery pagination

The homepage shows four facility cards per page, with numbered pages, Previous/Next controls, and a result range. Changing search, filters, sorting, vehicle, or booking window resets to page one. All matching facilities remain on the map; selecting a marker opens the corresponding results page.

## Operator Pro

Open `/operator/pro` from the operator navigation or business dashboard. Operator Pro costs **₹1,499 for one calendar month**, uses the existing simulated UPI/card checkout, and has no automatic renewal. Its entitlement and receipts are separate from Driver VIP. Standard facility, bay, reservation, and gate tools remain available without Pro.

- **Advanced analytics:** facility and 1–90 day filters, daily parking value, reservation counts, peak arrival hours, vehicle mix, reserved bay utilisation, and daily cancellations. Every chart includes numbered axes, units, gridlines, and hover/tap/keyboard value readouts. Cancellations use the reserved arrival date, with a total cancellation-rate summary. Values exclude cancellations; parking value excludes convenience fees. Collections count successful booking-linked receipts by payment date, while reservation figures use arrival dates. Utilisation estimates reserved time against current non-maintenance bay capacity, not live sensor occupancy.
- **Overstay alerts:** paginated, most-overdue-first alerts for owned facilities' checked-in vehicles past their reserved departure, refreshing every 15 seconds. Viewing the pass opens existing gate controls. Checkout clears the alert; no fine or automatic checkout is applied.
- **Scheduled pricing:** weekday/weekend/custom-day bands in IST, with editing and pause/enable controls. Enabled bands at a facility cannot overlap; each lasts at least 15 minutes. Split overnight bands into two rules, using 24:00 for midnight. Car/EV use the configured hourly rate; bikes use half rounded to a whole rupee. Bookings crossing bands are prorated per segment, then driver discounts and convenience fees apply. Discovery prices show the selected window's effective hourly rate. The server recalculates checkout totals and rejects stale quotes. Existing reservations and extensions retain their agreed effective rate.
- **CSV/PDF reports:** actual authenticated downloads containing only the operator's facility records, filtered by arrival date and facility, up to 90 days and 10,000 reservations. Reports include amounts, discounts, fees, and check-in/out times; PDF includes the summary. CSV text is escaped against spreadsheet formulas. Payments are simulated.

Pro expiry locks advanced tools and stops schedules applying to new quotes; saved schedules and existing booking prices are retained. Renew through checkout after expiry. The local demo adapter initializes pricing storage automatically. For an existing MySQL database, rerun `npm run db:setup` to add `users.operatorTier`, `users.operatorExpiresAt`, `bookings.pricingSnapshot`, and the `pricingRules` table. MySQL migration and behavior require verification against your configured MySQL instance; local tests use the demo adapter.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET / POST | `/api/operator/pro`, `/api/operator/pro/activate` | Own plan/receipts and paid demo activation |
| GET | `/api/operator/pro/analytics`, `/api/operator/pro/alerts` | Pro-only scoped analytics and paginated alerts |
| GET / POST / PATCH | `/api/operator/pro/rules`, `/api/operator/pro/rules/:id` | Read own schedules; Pro required to create/edit |
| GET | `/api/operator/pro/reports/csv`, `/api/operator/pro/reports/pdf` | Pro-only report attachments |
| GET | `/api/facilities/:id/quote` | Authoritative quote for startAt/endAt/vehicleType |

Implementation: `frontend/components/OperatorPro.jsx`, `frontend/app/operator-pro.css`, `backend/src/operator-pro.js`, `operator-policy.js`, `operator-analytics.js`, and `pricing.js`. PDF generation uses PDFKit. Integration tests cover activation/expiry, ownership, scheduled/VIP/bike pricing, overstay lifecycle, and both report formats.

## Project layout

- `frontend/app/`: Next.js routes and CSS, including `console.css`.
- `frontend/components/ParkEase.jsx`: session, discovery, booking, and operator flows.
- `frontend/components/ManagementConsole.jsx`: bounded admin tables and detail panels.
- `frontend/components/PaymentCheckout.jsx`: editable/validated simulated checkout.
- `frontend/components/Membership.jsx`: plans, savings, EV alerts, and support.
- `frontend/components/BookingDatePicker.jsx`, `booking-window.mjs`: tier-aware calendar/time boundaries.
- `frontend/components/HomeSections.jsx`, `SiteFooter.jsx`: homepage sections and public information pages.
- `backend/src/app.js`: Express REST routes and authorization.
- `backend/src/management.js`: admin pagination, aggregates, and audited account updates.
- `backend/src/store.js`: MySQL and persistent local demo adapters.
- `backend/src/payment.js`, `membership.js`: pricing/payment/membership rules.
- `backend/src/schema.sql`, `setup-db.js`: schema and additive migration.
- `backend/src/seed.js`, `catalog.js`: demonstration inventory.
- `shared/payment-validation.mjs`: shared UPI/card-format validation and test fixtures.
- `backend/test/`: isolated lifecycle, checkout, membership, management, and operator integration tests.

## Checks and production build

```powershell
npm test
npm run build
npm start
```

If OneDrive locks an old `.next` cache with an `EPERM` error, choose a fresh output folder for both build and start in the same PowerShell session:

```powershell
$env:PARKEASE_BUILD_DIR = '.next-verify'
npm run build
npm start
```

Build-cache folders are ignored by Git. Backend tests cover transaction rollback, overlapping/concurrent reservations, role/ownership boundaries, membership expiry/policies, payment failures and format validation, one-time convenience fees, pagination, account audit, suspension/session revocation, and location migration. This project is a local college demonstration; a real payment provider, operational contact channels, and physical hardware remain unconfigured.
