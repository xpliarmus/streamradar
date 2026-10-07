# Streamradar

Zeigt, was bei deinen Streaming-Anbietern (Schweiz) neu und im Trend ist. Pro Titel siehst du, ob er schon auf dem Jellyfin-Server liegt, und kannst ihn mit einem Klick in Jellyseerr requesten.

- **Daten:** TMDB, die Verfügbarkeit pro Anbieter stammt von JustWatch
- **Abgleich:** dein Jellyfin-Konto
- **Kein Server nötig:** Die App läuft komplett im Browser. TMDB-Key und Jellyfin-Token bleiben nur auf deinem Gerät gespeichert.

## 1. Schnelltest am PC

1. ZIP entpacken und `index.html` im Browser öffnen (Chrome, Edge oder Firefox).
2. Unter ⚙︎ **Einstellungen** den TMDB-Key einfügen und auf «Prüfen & speichern» klicken. Den Key bekommst du gratis unter themoviedb.org → Einstellungen → API.
3. Anbieter kontrollieren. Vorausgewählt sind die grossen Anbieter wie Netflix, Prime Video, Disney+, Apple TV+, HBO Max, Paramount+ und Play Suisse.
4. Jellyfin verbinden (Server-Adresse, Benutzer, Passwort) und die Jellyseerr-Adresse hinterlegen.

Als App installieren lässt sie sich erst, wenn sie online ist (Schritt 2).

## 2. Online stellen (nötig für die Handy-App)

### Variante A: GitHub Pages (kostenlos, empfohlen)

1. Auf github.com ein Konto anlegen und ein neues Repository «streamradar» erstellen (Public).
2. Über «Add file → Upload files» den **Inhalt** dieses Ordners hochladen. `index.html` muss zuoberst liegen. Danach «Commit».
3. Unter Settings → Pages bei «Source» die Option «Deploy from a branch» wählen, Branch `main`, Ordner `/ (root)`, und speichern.
4. Nach 1–2 Minuten ist die App erreichbar unter `https://<benutzername>.github.io/streamradar/`.

Das Repository ist öffentlich, enthält aber keine Zugangsdaten.

### Variante B: Netlify Drop

Auf app.netlify.com/drop den Ordner ins Fenster ziehen. Mit einem Gratis-Konto bleibt die Seite dauerhaft online.

## 3. Auf dem Handy installieren

- **iPhone (Safari):** Seite öffnen → Teilen-Symbol → «Zum Home-Bildschirm»
- **Android (Chrome):** Menü ⋮ → «App installieren» bzw. «Zum Startbildschirm hinzufügen»

Die installierte App hat einen eigenen Speicher. TMDB-Key und Jellyfin-Login dort einmal neu eingeben.

## Wenn Jellyfin nicht verbindet

- **https-Adresse verwenden.** Eine https-Seite darf keinen http-Server ansprechen.
- **Fehlermeldung «… erlaubt keine Zugriffe von dieser Web-App (CORS)»:** Der Server oder sein Reverse-Proxy lässt fremde Webseiten nicht zu. Abhilfe:
  - den Owner bitten, die App-Adresse freizugeben (CORS-Header), oder
  - die App direkt auf dem Server hosten lassen.
- **Titel ohne TMDB-ID in Jellyfin** werden nicht erkannt. Wie viele das sind, steht in den Einstellungen.

## Grenzen

- «Neu» heisst: kürzlich erschienen und aktuell beim Anbieter verfügbar. Das genaue Datum, an dem ein Titel zum Anbieter kam, kennt nur JustWatch. Dafür gibt es bei jedem Anbieter den Link «JustWatch».
- Requests laufen über den Link zu Jellyseerr. Direkt aus der App heraus requesten ist noch nicht möglich.

## Aktualisieren

Dateien ersetzen und in `sw.js` die `VERSION` erhöhen, damit installierte Apps die neue Version laden.

---
Dieses Produkt nutzt die TMDB-API, ist aber nicht von TMDB unterstützt oder zertifiziert.
