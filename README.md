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

## Dodavanje fraza
Sve fraze su u fajlu `phrases.js`. Dodaj frazu VELIKIM SLOVIMA u postojeću kategoriju (ili napravi novu kategoriju), pa `git push` — Render se sam ponovo objavi. `server.js` ne treba dirati. Fraze koje sadrže slova van bosanske abecede (Q, W, X, Y) ili posebne znakove server automatski preskače i ispiše upozorenje u logu.

## Pravila
- Domaćin bira 2 ili 3 igrača; igra ne može početi dok se ne pridruži tačan broj.
- Domaćin bira broj rundi: 1, 3 ili 5 (pri pravljenju sobe, a može ga promijeniti i u lobbyju). Kategorije i fraze su na BHS jezicima.
- Tačan suglasnik: broj pojavljivanja × vrijednost polja.
- Samoglasnik se kupuje za 250 bodova iz tekuće runde.
- Tačno rješenje: +500 bodova.
- Bankrot briše samo bodove osvojene u tekućoj rundi; prethodno osvojeni ukupni bodovi ostaju sačuvani. Gubi potez preskače igrača; Duplo udvostručuje sljedeće tačno slovo.
- Na kraju svake runde, preostali bodovi te runde dodaju se ukupnom rezultatu. Najveći ukupni zbir nakon posljednje runde pobjeđuje.
- Ako igrači dobrovoljno preskoče potez 3 puta zaredom (bilo koji igrači, bez ijedne akcije između), runda se završava, prikaže se rješenje i prelazi se na sljedeću rundu bez pobjednika i bez bodova. Kolo, slovo, samoglasnik ili rješavanje vraćaju brojač na nulu.
- Tastatura koristi bosansku abecedu bez Q, W, X i Y (DŽ, LJ i NJ se biraju kao dva slova).
- Kad se igra završi, domaćin može sve vratiti u lobby (nova igra) ili svako može izaći na početnu stranicu.

## Napomene za prvu verziju
- Ovo je igrivi MVP i treba ga testirati na ciljanoj platformi prije javnog korištenja.
- Namjerno nema baze podataka niti naloga; sobe i rezultati postoje dok server radi.
- U ovoj verziji su uključene početne fraze; kasnije se mogu dodati stotine fraza i dodatne kategorije.
