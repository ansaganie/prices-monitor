// Monitored BI Group real-estate objects.
//
// To add another object: append an entry below. `id` is the stable key used in
// data/state.json — never change it for an existing object, or its alert history
// resets and you get a duplicate first-run notification. `name` is display-only
// and safe to edit.
//
// Finding the UUIDs: open the complex's parking picker in a browser, watch the
// POST to apigw.bi.group/sales-picker/microfe-v3/placementList in devtools, and
// copy `realEstateUUIDs` / `propertyTypes` out of the request body.

/** Alert when an available unit's price is at or below this (KZT). */
export const PRICE_FLOOR = 2_200_000;

/** Alert when an object's available-unit count falls below this. */
export const AVAILABILITY_THRESHOLD = 20;

/** Parking / storage property types — shared by both complexes. */
const PARKING_PROPERTY_TYPES = [
  "fe0c5cbb-1dd7-4070-a62f-5e4871be2fa3",
  "1bea434a-a031-4107-bd26-99cc8566819f",
  "e439acf8-7816-4da4-abf1-c2f29e44aa64",
];

export const OBJECTS = [
  {
    id: "jetisu-satti",
    name: "Jetisu Satti — Паркинг",
    realEstateUUIDs: ["4f8fda10-ef89-11ef-a834-001dd8b726aa"],
    propertyTypes: PARKING_PROPERTY_TYPES,
    // Complex landing page. The API exposes no per-unit URL, so alerts link here
    // rather than to the exact placement — see README, "Unit deep links".
    url: "https://bi.group/ru/landing/jetisu-satti",
  },
  {
    id: "jetisu-kerbez-comfort",
    name: "Jetisu Kerbez Comfort — Паркинг",
    realEstateUUIDs: ["1a8988ee-b3b6-11ef-a830-001dd8b72708"],
    propertyTypes: PARKING_PROPERTY_TYPES,
    url: "https://bi.group/ru/landing/kerbez-comfort",
  },
];
