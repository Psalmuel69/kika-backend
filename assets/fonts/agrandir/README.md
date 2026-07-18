# Agrandir font files go here

Agrandir (used for the business name on receipts) is a commercial font
sold by Milieu Grotesque — it can't be redistributed in this repo.

If your Kika deployment owns a license, drop the .ttf/.otf files here,
e.g.:

    agrandir/Agrandir-GrandHeavy.ttf
    agrandir/Agrandir-Regular.ttf

receiptService.js generates a small fontconfig config on startup that
already includes this folder, so no extra setup is needed — just
restart the app after adding the files and receipts will start using
Agrandir for the business name automatically.

Until then, receipts fall back to a bold Fira Code render for the
business name, so nothing breaks — you just don't get the exact
Agrandir look.
