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
