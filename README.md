# Kolo sreće — online party igra

Online igra za **tačno 2 ili 3 igrača**, na bosanskom/hrvatskom/srpskom. Napravljena je kao Node.js + Express + Socket.IO aplikacija.

## Lokalno pokretanje
1. Instaliraj Node.js 18 ili noviji.
2. Raspakuj ZIP.
3. U terminalu, u folderu projekta, pokreni:
   ```bash
   npm install
   npm start
   ```
4. Otvori `http://localhost:3000`.

Za testiranje s više uređaja na istoj Wi-Fi mreži, drugi uređaji otvaraju lokalnu IP adresu računara, npr. `http://192.168.1.20:3000`.

## Objavljivanje na internetu
Najjednostavnije:
1. Napravi novi GitHub repository i dodaj sve fajlove iz ovog foldera.
2. Na Renderu napravi **New Web Service** i poveži repository.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Deploy; zatim otvori javni HTTPS URL na svakom mobitelu.

Aplikacija koristi Socket.IO i mora biti hostovana kao Node web service (ne samo kao statična stranica na Netlifyju). Sobe su trenutno pohranjene u memoriji servera, pa se resetuju ako se server restartuje. Za mali privatni party ovo je jednostavno rješenje.

## Pravila
- Domaćin bira 2 ili 3 igrača; igra ne može početi dok se ne pridruži tačan broj.
- Pet rundi, kategorije i fraze na BHS jezicima.
- Tačan suglasnik: broj pojavljivanja × vrijednost polja.
- Samoglasnik se kupuje za 250 bodova.
- Tačno rješenje: +500 bodova.
- Bankrot briše trenutni rezultat igrača; Gubi potez preskače igrača; Duplo udvostručuje sljedeće tačno slovo.
- Bodovi se prenose između rundi; najveći zbir nakon pet rundi pobjeđuje.

## Napomene za prvu verziju
- Ovo je igrivi MVP i treba ga testirati na ciljanoj platformi prije javnog korištenja.
- Namjerno nema baze podataka niti naloga; sobe i rezultati postoje dok server radi.
- U ovoj verziji su uključene početne fraze; kasnije se mogu dodati stotine fraza i dodatne kategorije.
