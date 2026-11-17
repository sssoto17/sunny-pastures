# Game assets

Candidate art packs for SHOULD-02 (free game assets instead of placeholder UI). Only human-made art:
no generative-AI packs. Assets that end up in the game are credited in `CREDITS.md`.

Source: a deep-research run on 2026-10-26 that covered several cosy-game themes. This list keeps the
packs that fit Sunny Pastures' farm and bakery. Licences are as reported then and have not been
rechecked; check each pack's page before using it.

Last changed: 2026-11-05.

## Candidates

<!-- prettier-ignore -->
| Pack                                                                                 | Licence                                                             | Fit                                                                                | Status      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| [Sprout Lands](https://cupnooble.itch.io/sprout-lands-asset-pack) (cupnooble)        | Free version non-commercial only; $3.99 version allows commercial use | Best match: pastel farming pixel art. Marked as made without generative AI.        | Not checked |
| [Kenney Animal Pack Redux](https://opengameart.org/content/animal-pack-redux)        | CC0 (no credit required, commercial use allowed)                    | 30 animals, 9 of them farm animals or pets. Likely covers chickens and cows.       | Not checked |
| [Neko Cafe](https://hellorumin.itch.io/neko-cafe-asset-pack) (hellorumin)            | Pay what you want, commercial use allowed                           | Pastries and café furniture for the bakery. Also has cat characters.               | Not checked |
| [Cozy Café Icons](https://opengameart.org/content/cozy-caf%C3%A9-icons)              | CC-BY 4.0 (credit the artist)                                       | Café and bakery product icons.                                                     | Not checked |
| [Kenney Furniture Kit](https://opengameart.org/content/furniture-kit)                | CC0                                                                 | 120 furniture pieces, 3D models and 2D sprites. Generic style; interiors only.     | Not checked |

## Non-pixel candidates

Found on 2026-11-05 in a search for art that isn't pixel art. Licences were read from each pack's
page that day, except where marked.

<!-- prettier-ignore -->
| Pack                                                                                 | Style                          | Licence                                                                   | Fit                                                                                                    | Status                  |
| ------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)                | Flat, colour or 3D-style; SVG and PNG | MIT (from the GitHub repo); redistribution allowed with the licence notice | Icons for every Must crop, animal and product: wheat (sheaf), corn, strawberry, chicken, cow, egg, milk, bread, croissant, shortcake, cake. | Licence checked         |
| [Farm puzzle animals](https://comigo.itch.io/farm-puzzle-animals) (comigo)           | Flat vector                    | CC0, but the page also asks you not to redistribute or resell the pack     | 6 crops and garden beds with two growth stages, fences, trees. Animals are pets, not farm animals. Tagged "No generative AI was used". | Licence checked         |
| [Kenney Isometric Miniature Farm](https://www.kenney.nl/assets/isometric-miniature-farm) | 2D isometric                   | CC0                                                                       | 60 files tagged "farm". The page doesn't list the contents, so crops, animals and buildings are unconfirmed. | Contents not checked    |
| [Vector Farm Pack](https://opengameart.org/content/vector-farm-pack) (OpenGameArt)   | Vector                         | CC0 according to search results; the page refused automated access        | Tagged crops, houses, animals and trees. Posted in 2012, so the style may look dated.                   | Not checked             |
| [Kenney Food Kit](https://www.kenney.nl/assets/food-kit)                             | 3D models                      | CC0                                                                       | 200 food models. Would need rendering to 2D images before use in a DOM UI. Low priority.               | Contents not checked    |

## Avoid

<!-- prettier-ignore -->
| Pack                                                                             | Reason                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Cafe and Tea Shop](https://pixelpossumstudio.itch.io/cafe-and-tea-shop-2d)      | No licence. Usable only with the author's written permission.              |

## Gaps

- Crop and product icons: covered by Microsoft Fluent Emoji, except animal feed. Sprout Lands
  probably covers some of the crops in pixel style.
- Facility sprites: feed mill, bakery and dairy buildings still need a source in either style.

## Before committing any asset

- **Redistribution.** The repo goes public in January for the exam. Many itch.io licences allow use
  in a game but forbid sharing the files themselves. If a pack's terms forbid that, keep its files
  out of git (gitignored, fetched by a script) or buy a licence that allows it.
- **AI disclosure.** itch.io "no AI" labels are declared by the artists and were not independently
  verified.
- **Credits.** Add every pack that ships to `CREDITS.md` with its author, link and licence. CC-BY
  packs require it; CC0 packs get a line anyway so the report's source list is complete.
