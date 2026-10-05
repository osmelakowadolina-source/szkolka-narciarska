/**
 * Cloud Functions dla Szkółki (v2, Node 20+). SZABLON — wdrażasz go po swojej stronie.
 *
 * Wdrożenie (jednorazowo):
 *   npm install -g firebase-tools
 *   firebase init functions   (Node.js, JavaScript)
 *   - wklej ten kod do functions/index.js
 *   - w functions/.env ustaw adres aplikacji (z ukośnikiem na końcu!), np.:
 *       APP_URL=https://osmelakowadolina-source.github.io/szkolka-narciarska/
 *     (aplikacja stoi w podkatalogu GitHub Pages, więc link "/" i ikony z "/icon-192.png"
 *      wskazywałyby na złą stronę)
 *   firebase deploy --only functions      (funkcje zaplanowane wymagają planu Blaze)
 *
 * Zmiany względem poprzedniej wersji:
 *  - USUNIĘTO sendReminders i dailyReminderCheck (bramka SMS). Od v1.22 SMS-y wysyła się
 *    z telefonu operatora, a sendReminders nie miała uwierzytelnienia — każdy z adresem URL
 *    mógłby wysyłać SMS-y na Twój koszt. Jeśli kiedyś wrócisz do bramki, użyj onCall
 *    z sprawdzeniem roli operatora.
 *  - daty i godziny liczone w strefie Europe/Warsaw (serwer działa w UTC — wcześniej
 *    koniec zajęć wychodził 1–2 h później, a po północy dzień się przesuwał),
 *  - guard "raz dziennie" jest atomowy (create) i zwalniany, gdy wysyłka się nie uda,
 *  - godzina powiadomienia = "od tej godziny, do godziny później", a nie wąskie okno ±15 min.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
admin.initializeApp();

const TZ = "Europe/Warsaw";
const APP_URL = process.env.APP_URL || "https://osmelakowadolina-source.github.io/szkolka-narciarska/";

/* ---------------- czas w strefie Europe/Warsaw ---------------- */
function warsawParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute,
    iso: `${p.year}-${p.month}-${p.day}`,
    minutes: (+p.hour) * 60 + (+p.minute),
  };
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Moment (ms UTC), w którym w Warszawie jest podana data i godzina. */
function warsawToMs(iso, h, m) {
  const [y, mo, d] = iso.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const w = warsawParts(new Date(guess));
  const offset = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - guess;
  return guess - offset;
}

/** Atomowe "zrób to tylko raz": zwraca false, jeśli ktoś już zarezerwował ten klucz. */
async function claimOnce(ref) {
  try {
    await ref.create({sentAt: admin.firestore.FieldValue.serverTimestamp()});
    return true;
  } catch (e) {
    if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return false;
    throw e;
  }
}

/* =====================================================================
   ZMIANA DANYCH LOGOWANIA INSTRUKTORA (e-mail / hasło) — OPCJONALNE
   ---------------------------------------------------------------------
   Aplikacja w przeglądarce NIE MOŻE zmienić e-maila ani hasła innego
   użytkownika — Firebase na to nie pozwala ze względów bezpieczeństwa.
   Wysyłka linku resetującego hasło działa bez tej funkcji (jest już
   wbudowana w panel Instruktorzy). Ta funkcja jest potrzebna tylko,
   jeśli chcesz móc ZMIENIĆ ADRES E-MAIL istniejącego konta.

   Po wdrożeniu wywołaj ją z aplikacji lub ręcznie (np. przez curl).
===================================================================== */
const {onCall, HttpsError} = require("firebase-functions/v2/https");

exports.updateInstructorCredentials = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Musisz być zalogowany.");

  // tylko operator może zmieniać cudze dane logowania
  const callerDoc = await admin.firestore().doc(`users/${callerUid}`).get();
  if (callerDoc.data()?.role !== "operator") {
    throw new HttpsError("permission-denied", "Tylko operator może zmieniać dane logowania.");
  }

  const {uid, newEmail, newPassword} = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "Brak UID instruktora.");

  // zmieniamy wyłącznie konta instruktorów (nie operatorów i nie dowolne UID)
  const targetDoc = await admin.firestore().doc(`users/${uid}`).get();
  if (targetDoc.data()?.role !== "instructor") {
    throw new HttpsError("failed-precondition", "To nie jest konto instruktora.");
  }

  const payload = {};
  if (newEmail) payload.email = newEmail;
  if (newPassword) {
    if (String(newPassword).length < 6) {
      throw new HttpsError("invalid-argument", "Hasło musi mieć min. 6 znaków.");
    }
    payload.password = newPassword;
  }
  if (Object.keys(payload).length === 0) {
    throw new HttpsError("invalid-argument", "Nie podano nowego e-maila ani hasła.");
  }

  await admin.auth().updateUser(uid, payload);

  // utrzymujemy zgodność profilu w Firestore z kontem logowania
  if (newEmail) {
    await admin.firestore().doc(`users/${uid}`).update({email: newEmail});
  }
  return {ok: true};
});

/* =====================================================================
   CODZIENNE POWIADOMIENIE PUSH DLA INSTRUKTORÓW
   ---------------------------------------------------------------------
   Wysyła np. "Jutro masz 5 h zajęć, zaczynasz o 9:00".

   Funkcja uruchamia się CO 15 MINUT i wysyła podsumowanie, gdy minie godzina
   ustawiona przez operatora w Ustawieniach (okno: godzina od ustawionego czasu).
   Raz dziennie dzięki atomowemu guardowi; przy awarii wysyłki guard jest zwalniany,
   więc kolejne uruchomienie spróbuje ponownie.
===================================================================== */
exports.sendDailyBrief = onSchedule(
  {schedule: "every 15 minutes", timeZone: TZ},
  async () => {
    const db = admin.firestore();
    const s = (await db.doc("settings/general").get()).data() || {};
    if (s.dailyBriefEnabled === false) return;

    const when = s.dailyBriefWhen || "evening"; // evening = o jutrze, morning = o dziś
    const [bh, bm] = (s.dailyBriefTime || "18:00").split(":").map(Number);
    const lessonDuration = s.lessonDuration || 55;

    const now = warsawParts();
    const briefMin = bh * 60 + bm;
    if (now.minutes < briefMin || now.minutes >= briefMin + 60) return;

    const dateIso = when === "evening" ? addDays(now.iso, 1) : now.iso;

    const guardRef = db.doc(`briefLog/${dateIso}-${when}`);
    if (!(await claimOnce(guardRef))) return;

    try {
      const lessonsSnap = await db.collection("lessons").where("date", "==", dateIso).get();
      const byInstructor = {};
      lessonsSnap.forEach((docSnap) => {
        const l = docSnap.data();
        if (l.status === "cancelled") return;
        (byInstructor[l.instructorId] = byInstructor[l.instructorId] || []).push(l);
      });

      // nieobecność na cały dzień — nie zawracamy głowy
      const absSnap = await db.collection("absences").where("date", "==", dateIso).get();
      const allDayOff = new Set();
      absSnap.forEach((d) => { if (d.data().allDay) allDayOff.add(d.data().instructorId); });

      const usersSnap = await db.collection("users").where("role", "==", "instructor").get();
      const dayWord = when === "evening" ? "Jutro" : "Dziś";
      const sends = [];

      usersSnap.forEach((userDoc) => {
        const uid = userDoc.id;
        const tokens = userDoc.data().fcmTokens || [];
        if (tokens.length === 0 || allDayOff.has(uid)) return;
        const mine = byInstructor[uid] || [];
        if (mine.length === 0) return;

        mine.sort((a, b) => a.time.localeCompare(b.time));
        const totalMin = mine.reduce((sum, l) => sum + (l.durationMinutes || lessonDuration), 0);
        const hours = totalMin / 60;
        const hoursText = Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
        const lessonWord = mine.length < 5 ? "zajęcia" : "zajęć";

        sends.push(admin.messaging().sendEachForMulticast({
          tokens,
          notification: {
            title: `${dayWord}: ${mine.length} ${lessonWord} (${hoursText})`,
            body: `Zaczynasz o ${mine[0].time}. Ostatnie zajęcia o ${mine[mine.length - 1].time}.`,
          },
          webpush: {
            fcmOptions: {link: APP_URL},
            notification: {icon: `${APP_URL}icon-192.png`, badge: `${APP_URL}icon-192.png`},
          },
        }).then(async (res) => {
          const dead = [];
          res.responses.forEach((r, i) => {
            const code = r.error?.code || "";
            if (code.includes("registration-token-not-registered") ||
                code.includes("invalid-argument")) dead.push(tokens[i]);
          });
          if (dead.length) {
            await db.doc(`users/${uid}`).update({fcmTokens: tokens.filter((t) => !dead.includes(t))});
          }
        }));
      });

      await Promise.all(sends);
      console.log(`Podsumowanie na ${dateIso}: wysłano do ${sends.length} instruktorów.`);
    } catch (e) {
      await guardRef.delete().catch(() => {}); // pozwól następnemu uruchomieniu spróbować ponownie
      throw e;
    }
  }
);

/* =====================================================================
   POWIADOMIENIE O ZALEGŁYCH PŁATNOŚCIACH
   ---------------------------------------------------------------------
   Co 15 minut (8:00–21:59 czasu polskiego) sprawdza zajęcia, które skończyły się
   ponad X minut temu ("paymentGraceMinutes") i nie są opłacone. Powiadamia
   operatora oraz instruktora prowadzącego. Każde zajęcia zgłaszane są RAZ
   (pole reminderPaymentSent).
===================================================================== */
exports.notifyUnpaidLessons = onSchedule(
  {schedule: "every 15 minutes", timeZone: TZ},
  async () => {
    const now = warsawParts();
    if (now.h < 8 || now.h >= 22) return; // w nocy nikogo nie budzimy

    const db = admin.firestore();
    const s = (await db.doc("settings/general").get()).data() || {};
    if (s.paymentAlertsEnabled === false) return;

    const grace = (s.paymentGraceMinutes ?? 20) * 60000;
    const lessonDuration = s.lessonDuration || 55;
    const nowMs = Date.now();

    // dziś i wczoraj (wg czasu polskiego) — starsze i tak już zgłoszone
    const snap = await db.collection("lessons")
      .where("date", "in", [now.iso, addDays(now.iso, -1)])
      .get();

    const due = [];
    snap.forEach((docSnap) => {
      const l = {id: docSnap.id, ...docSnap.data()};
      if (l.status === "cancelled" || l.paymentStatus === "paid" || l.reminderPaymentSent) return;
      const [h, m] = l.time.split(":").map(Number);
      const endMs = warsawToMs(l.date, h, m + (l.durationMinutes || lessonDuration));
      if (nowMs > endMs + grace) due.push(l);
    });
    if (due.length === 0) return;

    const usersSnap = await db.collection("users").get();
    const operators = [];
    const byUid = {};
    usersSnap.forEach((u) => {
      const data = u.data();
      byUid[u.id] = data;
      if (data.role === "operator" && (data.fcmTokens || []).length) operators.push(u.id);
    });

    const total = due.reduce((sum, l) => sum + (l.clientPrice || 0), 0);
    const names = [...new Set(due.map((l) => l.studentName))].slice(0, 3).join(", ");
    const more = due.length > 3 ? ` i ${due.length - 3} więcej` : "";

    const sendTo = async (uid, title, body) => {
      const tokens = byUid[uid]?.fcmTokens || [];
      if (!tokens.length) return;
      await admin.messaging().sendEachForMulticast({
        tokens,
        notification: {title, body},
        webpush: {fcmOptions: {link: APP_URL}, notification: {icon: `${APP_URL}icon-192.png`}},
      }).catch((e) => console.error("push error", uid, e));
    };

    await Promise.all(operators.map((uid) => sendTo(
      uid,
      `Nieopłacone zajęcia: ${due.length} (${Math.round(total)} zł)`,
      `${names}${more}. Dotknij, aby rozliczyć.`
    )));

    const perInstructor = {};
    due.forEach((l) => { (perInstructor[l.instructorId] = perInstructor[l.instructorId] || []).push(l); });
    await Promise.all(Object.entries(perInstructor).map(([uid, list]) => sendTo(
      uid,
      `Brak płatności za ${list.length} ${list.length === 1 ? "zajęcia" : list.length < 5 ? "zajęcia" : "zajęć"}`,
      list.map((l) => `${l.time} ${l.studentName} — ${Math.round(l.clientPrice || 0)} zł`).join(", ")
    )));

    const batch = db.batch();
    due.forEach((l) => batch.update(db.doc(`lessons/${l.id}`), {reminderPaymentSent: true}));
    await batch.commit();
    console.log(`Zgłoszono ${due.length} nieopłaconych zajęć.`);
  }
);

/* =====================================================================
   PRZYPOMNIENIE O WYSYŁCE SMS-ÓW (push do operatora)
   ---------------------------------------------------------------------
   Po godzinie ustawionej w aplikacji (Ustawienia → Przypomnienia SMS) wysyła
   operatorowi powiadomienie z liczbą zajęć do sprawdzenia. SMS-y wychodzą
   z telefonu operatora — funkcja ich nie wysyła.

   Uwaga: reguły "komu wysłać" (pierwsze zajęcia, powrót po przerwie…) liczy
   aplikacja, nie serwer. Dlatego treść mówi "do sprawdzenia", a nie
   "do wysłania" — liczba to górne oszacowanie.
===================================================================== */
exports.notifySmsQueue = onSchedule(
  {schedule: "every 15 minutes", timeZone: TZ},
  async () => {
    const db = admin.firestore();
    const s = (await db.doc("settings/general").get()).data() || {};
    if (s.smsPushEnabled === false) return;

    const when = s.smsPushDay || "evening";
    const [ph, pm] = (s.smsPushTime || "18:00").split(":").map(Number);
    const now = warsawParts();
    const pushMin = ph * 60 + pm;
    if (now.minutes < pushMin || now.minutes >= pushMin + 60) return;

    const dateIso = when === "evening" ? addDays(now.iso, 1) : now.iso;
    const guard = db.doc(`smsQueueLog/${dateIso}`);
    if (!(await claimOnce(guard))) return;

    try {
      const snap = await db.collection("lessons").where("date", "==", dateIso).get();
      const pendingCount = snap.docs.filter((d) => {
        const l = d.data();
        return l.status !== "cancelled" && !l.reminderSent && l.smsOverride !== "skip";
      }).length;
      if (pendingCount === 0) return;

      const usersSnap = await db.collection("users").where("role", "==", "operator").get();
      const dayWord = when === "evening" ? "Jutro" : "Dziś";

      await Promise.all(usersSnap.docs.map(async (u) => {
        const tokens = u.data().fcmTokens || [];
        if (!tokens.length) return;
        await admin.messaging().sendEachForMulticast({
          tokens,
          notification: {
            title: `${dayWord}: przypomnienia SMS`,
            body: `Do sprawdzenia do ${pendingCount} zajęć. Dotknij, aby otworzyć kolejkę.`,
          },
          webpush: {fcmOptions: {link: APP_URL}, notification: {icon: `${APP_URL}icon-192.png`}},
        }).catch((e) => console.error("push error", e));
      }));
    } catch (e) {
      await guard.delete().catch(() => {});
      throw e;
    }
  }
);
