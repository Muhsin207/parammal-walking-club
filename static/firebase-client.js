(() => {
  const defaultAnnouncement = {
    enabled: true,
    titleEn: "",
    titleMl: "",
    msgEn: "",
    msgMl: "ചെറിയ ചുവടുകൾ, വലിയ മാറ്റങ്ങൾ.",
    primaryLabel: "Learn More",
    linkUrl: ""
  };
  const defaultSiteContent = {
    bannerMode: "auto",
    slides: [],
    announcement: defaultAnnouncement
  };

  let firebaseApp;
  let auth;
  let firestore;
  let configurationError;
  let authReady = Promise.resolve();

  try {
    const config = window.PWC_FIREBASE_CONFIG;
    if (!window.firebase || !config ||
        Object.values(config).some((value) => !value || value.startsWith("YOUR_"))) {
      throw new Error("Add your Firebase web app settings to static/firebase-config.js.");
    }

    firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
    auth = firebaseApp.auth();
    firestore = firebaseApp.firestore();
    authReady = auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(() =>
      new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = auth.onAuthStateChanged(
          (user) => {
            unsubscribe();
            resolve(user);
          },
          (error) => {
            unsubscribe();
            reject(error);
          }
        );
      })
    );
  } catch (error) {
    configurationError = error;
  }

  function makeError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function ensureFirebaseReady() {
    if (configurationError) {
      throw makeError(configurationError.message, 503);
    }
    await authReady;
  }

  function mobileAuthEmail(mobile) {
    return `${mobile}@members.local`;
  }

  function normalizeFirebaseError(error, operation) {
    const messages = {
      "auth/email-already-in-use": {
        message: "An account with this mobile number already exists. Choose Login to sign in.",
        status: 409
      },
      "auth/invalid-email": {
        message: "Enter a valid 10-digit Indian mobile number.",
        status: 400
      },
      "auth/invalid-credential": {
        message: "Invalid mobile number or password.",
        status: 401
      },
      "auth/user-not-found": {
        message: "Invalid mobile number or password.",
        status: 401
      },
      "auth/wrong-password": {
        message: "Invalid mobile number or password.",
        status: 401
      },
      "auth/weak-password": {
        message: "Password must contain at least 8 characters.",
        status: 400
      },
      "auth/operation-not-allowed": {
        message: "Enable Email/Password sign-in in the Firebase console.",
        status: 503
      },
      "auth/network-request-failed": {
        message: "Could not reach Firebase. Check your internet connection and try again.",
        status: 503
      }
    };
    const mapped = messages[error.code];
    if (mapped) return makeError(mapped.message, mapped.status);
    console.error(`Firebase ${operation} failed`, error);
    return makeError(error.message || `Firebase ${operation} failed.`, 500);
  }

  function normalizedMobile(value) {
    const mobile = String(value || "").replace(/\D/g, "");
    return /^[6-9]\d{9}$/.test(mobile) ? mobile : null;
  }

  async function currentMember() {
    await ensureFirebaseReady();
    const user = auth.currentUser;
    if (!user) throw makeError("Sign in is required.", 401);

    const profileSnapshot = await firestore.collection("users").doc(user.uid).get();
    if (!profileSnapshot.exists) {
      throw makeError("Your account profile is missing. Contact the club administrator.", 403);
    }
    const profile = profileSnapshot.data();
    const token = await user.getIdTokenResult();
    return {
      id: user.uid,
      name: profile.displayName,
      isAdmin: token.claims.admin === true,
      monthlyGoal: Number(profile.monthlyGoal || 30)
    };
  }

  function normalizeSiteContent(content) {
    if (!content || !["auto", "poster", "slides"].includes(content.bannerMode) ||
        !Array.isArray(content.slides) || content.slides.length > 50 ||
        !content.announcement || typeof content.announcement !== "object") {
      throw makeError("Invalid poster settings.", 400);
    }

    const slides = content.slides.map((slide) => {
      if (!slide || typeof slide !== "object") {
        throw makeError("Each poster must be an object.", 400);
      }
      const image = String(slide.image || "").trim();
      const caption = String(slide.caption || "").trim();
      const tag = String(slide.tag || "").trim();
      let parsedImage;
      try {
        parsedImage = new URL(image);
      } catch {
        throw makeError("Enter a valid poster URL.", 400);
      }
      if (!["http:", "https:"].includes(parsedImage.protocol) ||
          caption.length > 180 || tag.length > 40) {
        throw makeError("Poster URLs must use http/https; captions and tags are limited in length.", 400);
      }
      return {
        id: String(slide.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        image: parsedImage.href,
        caption: caption || "Parammal Walking Club",
        tag: tag || "CLUB"
      };
    });

    const announcement = content.announcement;
    const linkUrl = String(announcement.linkUrl || "").trim();
    if (linkUrl) {
      let parsedLink;
      try {
        parsedLink = new URL(linkUrl);
      } catch {
        throw makeError("Enter a valid announcement link.", 400);
      }
      if (!["http:", "https:"].includes(parsedLink.protocol)) {
        throw makeError("Announcement links must use http or https.", 400);
      }
    }

    return {
      bannerMode: content.bannerMode,
      slides,
      announcement: {
        enabled: Boolean(announcement.enabled),
        titleEn: String(announcement.titleEn || "ANNOUNCEMENT").slice(0, 120),
        titleMl: String(announcement.titleMl || "അറിയിപ്പ്").slice(0, 120),
        msgEn: String(announcement.msgEn || "").slice(0, 2000),
        msgMl: String(announcement.msgMl || "").slice(0, 2000),
        primaryLabel: String(announcement.primaryLabel || "Learn More").slice(0, 80),
        linkUrl
      }
    };
  }

  async function apiRequest(path, options) {
    await ensureFirebaseReady();
    const requestOptions = options || {};
    const method = String(requestOptions.method || "GET").toUpperCase();
    const body = requestOptions.body || {};
    const url = new URL(path, window.location.origin);

    try {
      if (url.pathname === "/api/health" && method === "GET") {
        return { status: "ok" };
      }
      if (url.pathname === "/api/auth/register" && method === "POST") {
        const mobile = normalizedMobile(body.mobile);
        const displayName = String(body.displayName || "").trim();
        const password = String(body.password || "");
        if (!mobile) {
          throw makeError("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400);
        }
        if (!displayName || displayName.length > 80) {
          throw makeError("Enter a display name between 1 and 80 characters.", 400);
        }
        if (password.length < 8 || password.length > 128) {
          throw makeError("Password must contain 8 to 128 characters.", 400);
        }

        const credential = await auth.createUserWithEmailAndPassword(mobileAuthEmail(mobile), password);
        try {
          await firestore.collection("users").doc(credential.user.uid).set({
            displayName,
            monthlyGoal: 30,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (error) {
          try {
            await credential.user.delete();
          } catch (deleteError) {
            console.error("Could not remove Firebase account after profile creation failed", deleteError);
          }
          throw error;
        }
        return currentMember();
      }
      if (url.pathname === "/api/auth/login" && method === "POST") {
        const mobile = normalizedMobile(body.mobile);
        const password = String(body.password || "");
        if (!mobile) {
          throw makeError("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400);
        }
        if (!password) throw makeError("Enter your password.", 400);
        await auth.signInWithEmailAndPassword(mobileAuthEmail(mobile), password);
        return currentMember();
      }
      if (url.pathname === "/api/auth/me" && method === "GET") {
        return currentMember();
      }
      if (url.pathname === "/api/auth/logout" && method === "POST") {
        await auth.signOut();
        return { ok: true };
      }
      if (url.pathname === "/api/settings/me" && method === "PUT") {
        const goal = Number(body.monthlyGoal);
        if (!Number.isFinite(goal) || goal < 5 || goal > 500) {
          throw makeError("Monthly goal must be between 5 and 500 km.", 400);
        }
        const user = auth.currentUser;
        if (!user) throw makeError("Sign in is required.", 401);
        await firestore.collection("users").doc(user.uid).update({
          monthlyGoal: Math.round(goal * 100) / 100
        });
        return { monthlyGoal: Math.round(goal * 100) / 100 };
      }
      if (url.pathname === "/api/site-content" && method === "GET") {
        const snapshot = await firestore.collection("siteContent").doc("main").get();
        return snapshot.exists ? snapshot.data() : { ...defaultSiteContent };
      }
      if (url.pathname === "/api/site-content" && method === "PUT") {
        const content = normalizeSiteContent(body);
        await firestore.collection("siteContent").doc("main").set({
          ...content,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { ok: true };
      }
      throw makeError(`Unsupported Firebase operation: ${method} ${url.pathname}`, 404);
    } catch (error) {
      if (typeof error.status === "number") throw error;
      if (String(error.code || "").startsWith("auth/")) {
        throw normalizeFirebaseError(error, method.toLowerCase());
      }
      console.error(`Firebase request failed for ${method} ${url.pathname}`, error);
      throw makeError(error.message || "Firebase request failed.", 500);
    }
  }

  const walkPageSize = 500;
  let walkLogCursor = null;
  let walkLogMemberId = null;
  let walkLogsHaveMore = false;

  function normalizeGpsPath(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length < 2 || value.length > 2000) {
      throw makeError("GPS route must contain between 2 and 2,000 points.", 400);
    }
    return value.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 ||
          typeof point[0] !== "number" || typeof point[1] !== "number" ||
          !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
          point[0] < -90 || point[0] > 90 || point[1] < -180 || point[1] > 180) {
        throw makeError("GPS route contains an invalid coordinate.", 400);
      }
      return [point[0], point[1]];
    });
  }

  function walkLogFromDocument(document) {
    const data = document.data();
    const createdAt = data.createdAt && typeof data.createdAt.toMillis === "function"
      ? data.createdAt.toMillis()
      : Date.parse(data.createdAt || data.date);
    return {
      id: document.id,
      memberId: data.memberId,
      name: data.name,
      route: data.route,
      km: Number(data.km),
      mins: Number(data.mins),
      date: data.date,
      createdAt,
      gpsPath: normalizeGpsPath(data.gpsPath)
    };
  }

  function walkLogsQuery(cursor, limit, memberId) {
    let query = firestore.collection("walkLogs")
      .where("memberId", "==", memberId)
      .orderBy("date", "desc")
      .orderBy("createdAt", "desc")
      .limit(limit);
    if (cursor) query = query.startAfter(cursor);
    return query;
  }

  async function loadWalkPage(cursor, memberId) {
    const page = await walkLogsQuery(cursor, walkPageSize + 1, memberId).get();
    const visibleDocuments = page.docs.slice(0, walkPageSize);
    walkLogCursor = visibleDocuments.length
      ? visibleDocuments[visibleDocuments.length - 1]
      : cursor;
    walkLogsHaveMore = page.docs.length > walkPageSize;
    return {
      items: visibleDocuments.map(walkLogFromDocument),
      hasMore: walkLogsHaveMore
    };
  }

  async function loadLogs() {
    await ensureFirebaseReady();
    walkLogCursor = null;
    walkLogMemberId = null;
    walkLogsHaveMore = false;
    const memberId = auth.currentUser && auth.currentUser.uid;
    if (!memberId) return { items: [], hasMore: false };
    walkLogMemberId = memberId;
    return loadWalkPage(null, memberId);
  }

  async function loadMoreLogs() {
    await ensureFirebaseReady();
    if (!walkLogCursor || !walkLogsHaveMore || !walkLogMemberId) {
      return { items: [], hasMore: false };
    }
    const memberId = auth.currentUser && auth.currentUser.uid;
    if (!memberId) {
      walkLogCursor = null;
      walkLogMemberId = null;
      walkLogsHaveMore = false;
      return { items: [], hasMore: false };
    }
    if (memberId !== walkLogMemberId) return loadLogs();
    return loadWalkPage(walkLogCursor, memberId);
  }

  async function loadAllLogs() {
    await ensureFirebaseReady();
    const memberId = auth.currentUser && auth.currentUser.uid;
    if (!memberId) return [];
    const rows = [];
    let cursor = null;
    while (true) {
      const page = await walkLogsQuery(cursor, walkPageSize, memberId).get();
      rows.push(...page.docs.map(walkLogFromDocument));
      if (page.docs.length < walkPageSize) return rows;
      cursor = page.docs[page.docs.length - 1];
    }
  }

  async function createWalk(log) {
    await ensureFirebaseReady();
    const member = await currentMember();
    const route = String(log.route || "").trim();
    const distance = Number(log.km);
    const minutes = Number(log.mins);
    const date = String(log.date || "");
    if (!route || route.length > 120) throw makeError("Choose a valid route.", 400);
    if (!Number.isFinite(distance) || distance < 0.05 || distance > 100) {
      throw makeError("Distance must be between 0.05 and 100 km.", 400);
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      throw makeError("Duration must be between 1 and 600 minutes.", 400);
    }
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      throw makeError("Enter a valid walk date.", 400);
    }
    const gpsPath = normalizeGpsPath(log.gpsPath);
    const walk = {
      memberId: member.id,
      name: member.name,
      route,
      km: Math.round(distance * 100) / 100,
      mins: minutes,
      date,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (gpsPath) walk.gpsPath = gpsPath;
    const result = await firestore.collection("walkLogs").add(walk);
    return { id: result.id };
  }

  window.PWCFirebase = { apiRequest, loadLogs, loadMoreLogs, loadAllLogs, createWalk };
})();
