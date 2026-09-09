/**
 * PRZYKŁADOWY kod Cloud Functions dla przypomnień SMS.
 * To NIE jest gotowy, wdrożony kod — to szablon do wdrożenia po Twojej stronie,
 * bo wymaga klucza API bramki SMS, którego nie można umieścić w aplikacji webowej.
 *
 * Wdrożenie (jednorazowo):
 *   npm install -g firebase-tools
 *   firebase init functions   (wybierz Node.js, JavaScript)
 *   - wklej ten kod do functions/index.js
 *   - w functions/.env dodaj: SMS_API_KEY=twoj_klucz_od_dostawcy
 *   firebase deploy --only functions
 *
 * Dwie funkcje:
 *  1) sendReminders — wywoływana ręcznie z panelu (przycisk "Zatwierdź i wyślij")
 *  2) dailyReminderCheck — harmonogram o 18:00 codziennie, wysyła Ci powiadomienie
 *     (np. e-mail) z linkiem do panelu "Przypomnienia" do zatwierdzenia — bo realne
 *     wysyłanie SMS-ów bez Twojej zgody nie jest tu wykonywane automatycznie.
 */

const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
admin.initializeApp();

// ---- 1) Wywoływane przez przycisk "Zatwierdź i wyślij SMS-y" w aplikacji ----
exports.sendReminders = onRequest({cors: true}, async (req, res) => {
  const {lessons} = req.body; // [{id, phone, name, time, date, instructor}, ...]
  if (!Array.isArray(lessons) || lessons.length === 0) {
    return res.status(400).json({error: "Brak listy zajęć do przypomnienia"});
  }

  const results = [];
  for (const lesson of lessons) {
    const text =
      `Przypomnienie: jutro o ${lesson.time} masz zajecia narciarskie ` +
      `z instruktorem ${lesson.instructor}. Do zobaczenia! - Szkolka Narciarska`;
    try {
      await sendSms(lesson.phone, text); // patrz funkcja pomocnicza niżej
      results.push({id: lesson.id, ok: true});
    } catch (e) {
      results.push({id: lesson.id, ok: false, error: e.message});
    }
  }
  res.json({results});
});

// ---- 2) Harmonogram: codziennie o 18:00 czasu polskiego ----
exports.dailyReminderCheck = onSchedule(
  {schedule: "0 18 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = tomorrow.toISOString().slice(0, 10);

    const snap = await admin.firestore()
      .collection("lessons")
      .where("date", "==", iso)
      .where("reminderSent", "==", false)
      .get();

    if (snap.empty) return;

    // Tu możesz np. wysłać sobie e-mail/push z liczbą oczekujących przypomnień,
    // żeby wejść do panelu "Przypomnienia" i kliknąć "Zatwierdź i wyślij".
    // Jeśli wolisz PEŁNĄ automatyzację bez ręcznej zgody, możesz zamiast tego
    // od razu wywołać tu sendSms() dla każdego dokumentu z snap.docs — pomiń
    // wtedy krok zatwierdzania w aplikacji.
    console.log(`Jutro (${iso}) czeka ${snap.size} niewysłanych przypomnień.`);
  }
);

// ---- Funkcja pomocnicza: wysyłka pojedynczego SMS-a ----
// Przykład dla dostawcy z prostym HTTP API (np. Sendly/Actio, SMSAPI.pl).
// Podmień URL i format zapytania zgodnie z dokumentacją wybranego dostawcy.
async function sendSms(phone, text) {
  const apiKey = process.env.SMS_API_KEY;
  const response = await fetch("https://api.dostawcasms.pl/v1/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to: phone,
      message: text,
      sender: "SzkolkaSki", // nadpis nadawcy (jeśli dostawca wspiera)
    }),
  });
  if (!response.ok) {
    throw new Error(`Błąd wysyłki SMS: ${response.status}`);
  }
  return response.json();
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

   Funkcja uruchamia się CO 15 MINUT i sama sprawdza, czy wybiła godzina
   ustawiona przez operatora w aplikacji (Ustawienia → Codzienne
   powiadomienie). Dzięki temu zmiana godziny w aplikacji działa od razu,
   bez ponownego wdrażania funkcji.

   Wymaga planu Blaze (funkcje zaplanowane nie działają na planie Spark).
   Wdrożenie: firebase deploy --only functions
===================================================================== */

exports.sendDailyBrief = onSchedule(
  {schedule: "every 15 minutes", timeZone: "Europe/Warsaw"},
  async () => {
    const db = admin.firestore();

    const settingsSnap = await db.doc("settings/general").get();
    const s = settingsSnap.data() || {};
    if (s.dailyBriefEnabled === false) return;

    const briefTime = s.dailyBriefTime || "18:00";
    const when = s.dailyBriefWhen || "evening"; // evening = o jutrze, morning = o dziś
    const lessonDuration = s.lessonDuration || 55;

    // czy właśnie teraz wypada ustawiona godzina? (okno 15 minut)
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Warsaw"}));
    const [bh, bm] = briefTime.split(":").map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const briefMin = bh * 60 + bm;
    if (Math.abs(nowMin - briefMin) >= 15) return;

    // której daty dotyczy podsumowanie
    const target = new Date(now);
    if (when === "evening") target.setDate(target.getDate() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const dateIso = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;

    // zabezpieczenie przed podwójną wysyłką tego samego dnia
    const guardRef = db.doc(`briefLog/${dateIso}-${when}`);
    if ((await guardRef.get()).exists) return;
    await guardRef.set({sentAt: admin.firestore.FieldValue.serverTimestamp()});

    // zajęcia na dany dzień
    const lessonsSnap = await db.collection("lessons").where("date", "==", dateIso).get();
    const byInstructor = {};
    lessonsSnap.forEach((docSnap) => {
      const l = docSnap.data();
      if (l.status === "cancelled") return;
      if (!byInstructor[l.instructorId]) byInstructor[l.instructorId] = [];
      byInstructor[l.instructorId].push(l);
    });

    // nieobecności — nie zawracamy głowy komuś, kto zgłosił wolne
    const absSnap = await db.collection("absences").where("date", "==", dateIso).get();
    const allDayOff = new Set();
    absSnap.forEach((d) => { if (d.data().allDay) allDayOff.add(d.data().instructorId); });

    const usersSnap = await db.collection("users").where("role", "==", "instructor").get();
    const dayWord = when === "evening" ? "Jutro" : "Dziś";
    const sends = [];

    usersSnap.forEach((userDoc) => {
      const uid = userDoc.id;
      const user = userDoc.data();
      const tokens = user.fcmTokens || [];
      if (tokens.length === 0) return;              // brak zgody na powiadomienia
      if (allDayOff.has(uid)) return;                // zgłoszona nieobecność

      const mine = byInstructor[uid] || [];
      if (mine.length === 0) return;                 // nic nie ma — nie zawracamy głowy

      mine.sort((a, b) => a.time.localeCompare(b.time));
      const first = mine[0].time;
      const totalMin = mine.reduce((sum, l) => sum + (l.durationMinutes || lessonDuration), 0);
      const hours = totalMin / 60;
      const hoursText = Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
      const lessonWord = mine.length === 1 ? "zajęcia" : (mine.length < 5 ? "zajęcia" : "zajęć");

      sends.push(admin.messaging().sendEachForMulticast({
        tokens,
        notification: {
          title: `${dayWord}: ${mine.length} ${lessonWord} (${hoursText})`,
          body: `Zaczynasz o ${first}. Ostatnie zajęcia o ${mine[mine.length - 1].time}.`,
        },
        webpush: {
          fcmOptions: {link: "/"},
          notification: {icon: "/icon-192.png", badge: "/icon-192.png"},
        },
      }).then(async (res) => {
        // sprzątanie nieaktualnych tokenów (np. odinstalowana aplikacja)
        const dead = [];
        res.responses.forEach((r, i) => {
          const code = r.error?.code || "";
          if (code.includes("registration-token-not-registered") ||
              code.includes("invalid-argument")) dead.push(tokens[i]);
        });
        if (dead.length) {
          await db.doc(`users/${uid}`).update({
            fcmTokens: tokens.filter((t) => !dead.includes(t)),
          });
        }
      }).catch((e) => console.error("Błąd wysyłki dla " + uid, e)));
    });

    await Promise.all(sends);
    console.log(`Podsumowanie na ${dateIso}: wysłano do ${sends.length} instruktorów.`);
  }
);

/* =====================================================================
   POWIADOMIENIE O ZALEGŁYCH PŁATNOŚCIACH
   ---------------------------------------------------------------------
   Sprawdza co 15 minut, czy są zajęcia, które się skończyły ponad
   X minut temu (ustawienie "paymentGraceMinutes" w aplikacji) i wciąż
   nie są opłacone. Powiadamia operatora oraz instruktora prowadzącego.

   Każde zajęcia zgłaszane są tylko RAZ — pole reminderPaymentSent
   zapobiega powtarzaniu powiadomień co kwadrans.
===================================================================== */
exports.notifyUnpaidLessons = onSchedule(
  {schedule: "every 15 minutes", timeZone: "Europe/Warsaw"},
  async () => {
    const db = admin.firestore();
    const s = (await db.doc("settings/general").get()).data() || {};
    if (s.paymentAlertsEnabled === false) return;

    const grace = (s.paymentGraceMinutes ?? 20) * 60000;
    const lessonDuration = s.lessonDuration || 55;
    const now = Date.now();

    // wystarczy sprawdzić dziś i wczoraj — starsze i tak już zgłoszone
    const pad = (n) => String(n).padStart(2, "0");
    const d0 = new Date();
    const d1 = new Date(d0.getTime() - 86400000);
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const snap = await db.collection("lessons")
      .where("date", "in", [iso(d0), iso(d1)])
      .get();

    const due = [];
    snap.forEach((docSnap) => {
      const l = {id: docSnap.id, ...docSnap.data()};
      if (l.status === "cancelled") return;
      if (l.paymentStatus === "paid") return;
      if (l.reminderPaymentSent) return;
      const [h, m] = l.time.split(":").map(Number);
      const end = new Date(`${l.date}T00:00:00`);
      end.setHours(h, m + (l.durationMinutes || lessonDuration), 0, 0);
      if (now > end.getTime() + grace) due.push(l);
    });
    if (due.length === 0) return;

    // odbiorcy: operatorzy + instruktorzy, których dotyczą zaległe zajęcia
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
        webpush: {fcmOptions: {link: "/"}, notification: {icon: "/icon-192.png"}},
      }).catch((e) => console.error("push error", uid, e));
    };

    // operator dostaje zbiorcze podsumowanie
    await Promise.all(operators.map((uid) => sendTo(
      uid,
      `Nieopłacone zajęcia: ${due.length} (${Math.round(total)} zł)`,
      `${names}${more}. Dotknij, aby rozliczyć.`
    )));

    // instruktor dostaje informację o swoich zajęciach
    const perInstructor = {};
    due.forEach((l) => {
      if (!perInstructor[l.instructorId]) perInstructor[l.instructorId] = [];
      perInstructor[l.instructorId].push(l);
    });
    await Promise.all(Object.entries(perInstructor).map(([uid, list]) => sendTo(
      uid,
      `Brak płatności za ${list.length} zajęcia`,
      list.map((l) => `${l.time} ${l.studentName} — ${Math.round(l.clientPrice || 0)} zł`).join(", ")
    )));

    // oznaczamy jako zgłoszone, żeby nie powtarzać co kwadrans
    const batch = db.batch();
    due.forEach((l) => batch.update(db.doc(`lessons/${l.id}`), {reminderPaymentSent: true}));
    await batch.commit();

    console.log(`Zgłoszono ${due.length} nieopłaconych zajęć.`);
  }
);
