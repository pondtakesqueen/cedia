# shop

A small order-pricing service. Prices are in cents everywhere inside `src/`; only `src/format/` turns cents into text.

## Pricing rules

1. A line's subtotal is unit price times quantity.
2. Bulk discount: a line with **10 or more** units gets 5% off that line; **50 or more** units gets 10% off. Only the highest tier applies. Units count per SKU across the whole cart: lines of the same SKU are merged into one before pricing.
3. Coupons apply to the order after bulk discounts: `SAVE10` takes 10% off, `FLAT5` takes 500 cents off (never below zero). One coupon per order.
4. Shipping: each region has a flat rate and a free-shipping threshold. Shipping is free when the **discounted** subtotal (after bulk discounts and the coupon, before tax) is at least the threshold.
5. Tax is charged on the discounted subtotal plus shipping, at the region's rate, rounded half up to the cent.
6. The total is discounted subtotal + shipping + tax.

## Regions

| Region | Tax | Shipping | Free shipping from |
|---|---|---|---|
| US | 7% | 800 | 5000 |
| EU | 20% | 900 | 6000 |
| UK | 20% | 700 | 4000 |
