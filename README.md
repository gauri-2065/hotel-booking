# Hotel Room Booking System
Express.js + SQLite (better-sqlite3) + HTML/CSS/JavaScript (Fetch API).

## Run
    npm install
    npm start        # http://localhost:3000

Six sample rooms are created on first run. The database file is `hotel.db`.

## Structure
    server.js          Express server, routes, validation, SQLite schema
    public/index.html  Frontend (updates the page with fetch, no reload)

## REST API (JSON)
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/rooms | List all rooms (with "booked today" flag) |
| GET | /api/rooms/search?type=&checkIn=&checkOut= | Search available rooms by type and dates |
| POST | /api/rooms | Add a room `{roomNo,type,price}` |
| PUT | /api/rooms/:id | Update type, price or status (Available/Maintenance) |
| DELETE | /api/rooms/:id | Delete a room |
| GET | /api/bookings | List bookings |
| POST | /api/bookings | Book a room `{roomId,guestName,checkIn,checkOut}` |
| DELETE | /api/bookings/:id | Cancel a booking |

## Validation and edge cases
- Overlap rule: a new stay conflicts if `existing.check_in < new.check_out AND existing.check_out > new.check_in`, so same-day check-out and check-in is allowed. Conflicts return HTTP 409.
- Check-out must be after check-in, check-in cannot be in the past (400).
- Booking a missing room or cancelling a non-existent booking returns 404; duplicate room number returns 409.
