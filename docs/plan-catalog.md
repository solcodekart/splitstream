# Plan catalog — pricing sources

The host "Create pool" form pre-fills a suggested **per-seat** price as `full plan price ÷ seats`
(editable). The numbers live in `PLATFORMS` in `app/src/App.jsx`. `price.US` is the current US
list price; `price.EU` is a representative eurozone price (these vary by country). Annual-only
plans are shown as their per-month equivalent. `seats` is how many people the plan officially
lets share (accounts / profiles / concurrent streams, whichever is the real sharing limit).

Prices captured ~July 2026. Streaming prices change often — re-check before a real launch.

| Service | Plan | Seats | US /mo | EU /mo | Notes |
|---|---|---|---|---|---|
| Spotify | Premium Family | 6 | $21.99 | €21.99 | Up to 6 accounts; Jan 2026 US hike. FR ~€19.99. |
| Netflix | Premium 4K | 4 | $26.99 | €21.99 | Mar 2026 hike; 4 concurrent streams, +2 extra members. |
| YouTube Premium | Family | 6 | $26.99 | €29.99 | Up to 6; US hike Apr/Jun 2026; EU €29.99. |
| Disney+ | Premium | 4 | $18.99 | €15.99 | Ad-free Premium; 4 concurrent streams. |
| Apple Music | Family | 6 | $16.99 | €16.99 | Up to 6 members. |
| Apple TV+ | Monthly | 6 | $12.99 | €9.99 | Family Sharing up to 6. |
| Amazon Prime | Prime | 3 | $14.99 | €8.99 | Monthly Prime; Prime Video 3 concurrent streams; EU varies (FR €6.99, DE €8.99). |
| Max | Standard | 2 | $18.49 | €9.99 | Standard = 2 concurrent streams. |
| Hulu | No Ads | 2 | $18.99 | €18.99 | US-only service; EU shown as USD-parity placeholder. |
| Paramount+ | Premium | 6 | $13.99 | €7.99 | Premium ad-free (w/ Showtime); Jan 2026 US hike. |
| Peacock | Premium | 3 | $10.99 | €10.99 | US-focused; EU shown as USD-parity placeholder. |
| Nintendo Switch Online | Family | 8 | $2.92 | €2.92 | $34.99/yr ÷ 12; up to 8 accounts. |

Hulu and Peacock are effectively US-only; their EU figures are placeholders at USD parity so the
region-aware form still has a value. If a pool is hosted in EUR for those, adjust manually.

## Sources

- Spotify — https://variety.com/2026/digital/news/spotify-price-increase-us-subscription-plans-1236632136/ , https://www.spotify.com/us/family/
- Netflix — https://www.cnbc.com/2026/03/26/netflix-raises-prices-across-all-streaming-plans.html , https://help.netflix.com/en/node/24926
- YouTube Premium — https://variety.com/2026/digital/news/youtube-premium-pirce-increase-youtube-music-us-1236713223/ , https://www.imdb.com/news/ni64843403/
- Disney+ — https://help.disneyplus.com/article/disneyplus-price
- Apple Music / Apple TV+ — https://www.nerdwallet.com/finance/learn/how-much-does-apple-music-cost , https://www.apple.com/apple-one/
- Amazon Prime — https://www.nerdwallet.com/finance/learn/amazon-prime-benefits-cost-worth , https://www.spliiit.com/en/blog/prime-video-abonnement-prix
- Max — https://www.dealnews.com/features/hbo-max-subscription-cost/ , https://www.techradar.com/deals/hbo-max-price-cost-deals
- Hulu — https://smarttvs.org/hulu-plans-2026/
- Paramount+ — https://variety.com/2025/tv/news/paramount-to-hike-prices-in-early-2026-1236574467/
- Peacock — https://www.peacocktv.com/help/article/how-much-does-a-peacock-subscription-cost
- Nintendo Switch Online — https://www.nintendo.com/us/online/ , https://www.spliiit.com/en/blog/nintendo-switch-online-prix-famille
