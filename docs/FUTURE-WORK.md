# Future Work

## Move mobile WhatsApp handoffs to the Cloud API

Until the mobile Cloud API delivery flow is ready, mobile booking, check-in,
checkout, and food-bill messages use an explicit cashier handoff: BillNest
opens WhatsApp with the customer number and a prepared message (and attaches
the invoice PDF at checkout), and the cashier reviews and taps Send.

When completing Cloud API messaging on mobile:

- Migrate every mobile message trigger and saved template to the Cloud API,
  including booking confirmation, check-in, room checkout PDF, and food bills.
- Add delivery/error status and safe retry handling for all of those message
  types.
- Remove the temporary mobile WhatsApp app/share-sheet handoff and its
  trigger-specific UI copy only after Cloud API delivery is verified end to end.
- Preserve the cashier's ability to review recipient and message details before
  sending wherever the Cloud API policy and approved templates allow it.
