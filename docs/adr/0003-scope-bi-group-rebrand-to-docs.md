# Scope the BI Group rebrand to prose, not a provider abstraction

Status: accepted

This service is being repositioned as a generic multi-product price monitor rather than a BI-Group-specific tool, since it's expected to watch other products' listings in the future. We're limiting that change to prose — README, CLAUDE.md, and `config/objects.js`'s doc comment describe it generically — and explicitly *not* building a provider/adapter abstraction now. Internal code (`src/bi-api.js`, `fetchAllPlacements`, `realEstateUUIDs`/`propertyTypes` field names), the Telegram message's own text, and `package.json`'s `"name"` all keep BI Group naming, because that's genuinely and solely what's configured and monitored today.

## Considered Options

- **Build a provider/adapter interface now** (each Monitored Object declares a provider; `bi-api.js` becomes one adapter among a registry) — rejected as speculative: there is no second provider to design the interface against yet, and guessing its shape ahead of a real second integration is the kind of premature abstraction the project avoids elsewhere. Revisit when an actual second product needs a genuinely different request/response shape.

## Consequences

A future reader will find `bi-api.js`, `realEstateUUIDs`, and a Telegram message reading "BI Group — паркинг" sitting next to docs that describe the project generically — that's intentional, not an incomplete rename: the docs describe what the *system* is for, the code and messages describe what's *actually configured*, and those are allowed to diverge until a second product exists. `config/objects.js`'s comment should say plainly that today's entry shape is BI Group's API vocabulary and that a different provider would need a new fetch adapter that doesn't exist yet.
