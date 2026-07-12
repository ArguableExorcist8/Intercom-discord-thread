# Intercom To Discord Follow-up Bot

The bot receives Intercom conversation ID, fetches the ticket from Intercom, summarizes it with AI, and creates a routed Discord thread.

## Routing

Threads may have multiple forum tags. The bot applies tags in this order: `VIP/Partner`, `URGENT`, `Bug Bounty`, `Standard`.

- `VIP/Partner`: contact is a partner or level 50+. This can combine with another tag.
- `URGENT`: active, system-wide production/security/data/infrastructure emergency. This is the only tag that automatically pings oop and nikita.
- `Bug Bounty`: non-emergency developer or security investigation. It does not auto-ping developers; a researcher report can still combine with `URGENT` when an active exploit is involved.
- `Standard`: fallback for tickets that are neither urgent nor bug-bounty investigations.

## Security Operations

- `.env.example` contains placeholders.

## API Contract

See [docs/API.md](docs/API.md)