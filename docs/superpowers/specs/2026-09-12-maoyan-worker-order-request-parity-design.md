# Maoyan Worker Order Request Parity Design

## Problem

The local HTTP client can create an unpaid order with an uploaded Maoyan session, while the Worker receives `NetError / Bad Request` with the same session. The Worker currently serializes selected seats as seat-number strings, but the known-good browser request and local client serialize full seat objects. The Worker also omits AJAX request headers and the movie/cinema query parameters from the seat-page referrer.

## Design

Keep `createUnpaidOrder(session, seatMap, seatNos)` as the public interface. Resolve each requested seat number against `seatMap.seats`, verify availability, and serialize only the provider fields `rowId`, `columnId`, `seatNo`, and `type`. Do not serialize the Worker's internal `available` field.

Add `movieId` and `cinemaId` to the seat-map result in `fetchSeatMap` so `createUnpaidOrder` can construct the same complete seat-page referrer used by the local client. Send the same `Accept`, `Accept-Language`, and `X-Requested-With` headers as the local client.

The provider's `NetError / Bad Request` response will remain classified as a certain rejection, but its user-facing message will no longer state that the session or signature is necessarily expired. This avoids presenting an unverified diagnosis as fact.

## Testing

Update the Worker client test to require the full seat object payload, complete referrer, and AJAX headers. Keep all network calls mocked. Run the focused client test first, then the complete Worker test suite.

## Scope

No changes to local login, session upload format, lock-rule scheduling, payment behavior, or production data. No real order will be created during automated verification.
