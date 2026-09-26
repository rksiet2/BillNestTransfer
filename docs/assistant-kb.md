<!--
  BillNest Assistant Knowledge Base
  ----------------------------------
  This file feeds the fully-offline in-app AI Assistant (floating button,
  bottom-right of every screen). Each question is a level-2 heading ("## ");
  everything under it up to the next "## " is the answer shown to the user.

  Keep answers short, practical, and step-by-step. Add new Q&A entries here
  any time a new feature ships — no code change is needed, the assistant
  re-reads this file automatically at build time.
-->

## How do I add a new food item?
Go to Food Billing → Food Details tab → click "+ Add Food Item". Fill in Name, Category, Price, Veg/Non-Veg, and optionally upload a photo. Click Save — it appears in the menu instantly.

## How do I edit or delete a food item?
In Food Billing → Food Details, find the item in the list and click "Edit" to change its details, or "Delete" to remove it permanently.

## How do I add a new category?
In Food Billing → Food Details, use the "+ Add Category" option near the top of the list — categories are used to group the menu (Starters, Main Course, Breads, etc.) for the category-wise menu view and search.

## How do I generate a bill / create an order?
Go to Food Billing → Billing tab, tap food items to add them to the cart (use + / − to adjust quantity), select Cash or Online as the payment method, then click "Generate Bill". You need at least 1 item in the cart to generate a bill.

## How do I apply a discount or change the tax rate on a bill?
In the Billing/Cart screen, use the "Discount (₹)" field and the "Tax / GST Rate" dropdown just above the bill total — both update the final total live before you generate the bill.

## How do I cancel an order/bill?
Open Reporting → Bill History, find the bill, and click "Cancel". Cancelled bills are excluded from all revenue totals and reports, but stay visible in history for record-keeping.

## Where is the bill saved after I generate it?
Every generated bill opens in its own printable window and is also saved as a PDF/record inside the "Bill Records" folder on this computer, organized by date.

## How do I see today's / weekly / monthly / yearly sales?
Go to Reporting → Sales Summary and choose Today, Week, Month, or Year from the period tabs at the top — it shows total revenue, order count, cash vs online split, and top-selling items for that period.

## What is the token number (B01, G01, etc.)?
Every bill gets a short token: "B" prefix for Cash bills, "G" prefix for Online payments, followed by a running number (e.g. B01, G07) that resets daily — it's for quick order tracking/calling out at the counter, shown on the bill and KOT.

## How do I search for a food item quickly?
Use the search bar at the top of the Billing screen — it searches across all categories at once and shows each item's photo with quantity +/− controls, so you don't need to open a category first.

## How do I add a new room?
Go to Room Booking → Rooms tab → "+ Add Room". Enter Room Number, Room Type, Base Price/Night, and Max Occupancy, then Save.

## How do I create a new booking / check in a guest?
Go to Room Booking → Bookings tab → "+ New Booking". Fill in Guest Details (name, phone, optional email/special request — click "+ Add Guest Contact" for more guests) and Room Details (pick a room, check-in/check-out date & time, rate). You can click "+ Add Room" to book multiple rooms for the same guest in one reservation. Save to create the booking as "Booked", then use "Check In" when the guest actually arrives.

## How do I check out a guest?
In Room Booking → Bookings tab, find the booking with status "Checked In" and click "Check Out". This finalizes the stay, deducts any advance payment already collected, and generates the final invoice automatically.

## How do I cancel a booking?
In Room Booking → Bookings tab, click "Cancel" on a Booked or Checked-in row, optionally type a reason, and confirm. A cancelled booking is never billed and is excluded from Hotel revenue.

## How do I take an advance payment for a booking?
While creating or editing a booking, use the "Advance Payment" section to enter the amount and payment method — it's automatically deducted from the final bill at checkout, and remaining balance is shown as "Balance Due".

## What do the room status colors mean on the Room Status Board?
The colored left bar on each room card shows its current state: green = Available, blue = Occupied (guest checked in), yellow = Reserved/Booked (arriving soon, not checked in yet), grey = Under Maintenance.

## How do I mark a room under maintenance?
Go to Room Booking → Rooms tab, find the room, and click "Set Maintenance". Click "Set Active" on the same room later to make it bookable again.

## How do I record a purchase / raw material expense?
Go to Purchases, select or add the Raw Material (name + unit + cost/unit), enter quantity purchased and payment method, then Save — this feeds into Profit & Loss reporting as a cost.

## How do I record a general expense (rent, salary, utilities)?
Go to Expenses, click "+ Add Expense", choose a category, enter the amount and payment method, then Save.

## How do I see Profit & Loss?
Go to Reporting → Profit & Loss and pick a period. It shows Revenue − Purchases − Expenses = Net Profit, plus a breakdown of expenses by category.

## How do I add a staff account / give someone login access?
Go to Settings → Manage Staff → "+ Add Staff", set their name and a 4-6 digit PIN. Staff accounts can be restricted to only Food Billing or only Room Booking from the same screen.

## How do I reset someone's PIN or deactivate a staff account?
Go to Settings → Manage Staff, find the staff member, and click "🔑 Reset PIN" or "🚫 Deactivate". The Owner account itself can never be deactivated.

## How do I change the hotel name, address, or logo shown on bills?
Go to Settings → Hotel Details and update the Hotel Name, Address, Phone, GSTIN, and Logo — these appear on every printed bill and invoice.

## How do I change the tax/GST percentage used by default?
Go to Settings → Tax / GST Rate and pick the default percentage — this pre-fills on new bills and bookings, but can still be overridden per-bill.

## Can this app work without internet?
Yes — BillNest is a fully offline desktop app. Billing, room booking, reporting, and this Assistant all work with no internet connection required. Only optional features like syncing with Zomato/Swiggy/MMT need internet.

## Does this app have a mobile version?
Yes — BillNest has a companion Android app with matching billing, room booking, and reporting features, so staff can manage the front desk from a phone or tablet as well as the desktop.
