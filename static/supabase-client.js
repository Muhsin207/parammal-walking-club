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

  let supabase;
  let configurationError;

  try {
    const config = window.PWC_SUPABASE_CONFIG;
    if (!window.supabase || !config ||
        !config.url.startsWith("https://") ||
        config.url.includes("YOUR_") ||
        !config.publishableKey || config.publishableKey.includes("YOUR_")) {
      throw new Error("Add your Supabase project URL and publishable key to static/supabase-config.js.");
    }
    supabase = window.supabase.createClient(config.url, config.publishableKey);
  } catch (error) {
    configurationError = error;
  }

  function makeError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function ensureSupabaseReady() {
    if (configurationError) throw makeError(configurationError.message, 503);
  }

  async function getWeeklyTopper() {
    await ensureSupabaseReady();
    const { data, error } = await supabase.rpc("get_weekly_topper");
    if (error) {
      if (error.code === "PGRST202") {
        console.error("Supabase weekly topper is unavailable until migration 004 is applied.", error);
        throw makeError("Weekly topper setup is incomplete. Run supabase/migrations/004_weekly_topper.sql.", 503);
      }
      throw normalizeSupabaseError(error, "weekly topper");
    }
    if (!Array.isArray(data)) throw makeError("Unexpected weekly topper response.", 500);
    return data;
  }

  async function getPublicLeaderboard() {
    await ensureSupabaseReady();
    const { data, error } = await supabase.rpc("get_public_leaderboard");
    if (error) {
      if (error.code === "PGRST202") {
        console.error("Supabase leaderboard is unavailable until migration 006 is applied.", error);
        throw makeError("Leaderboard setup is incomplete. Run supabase/migrations/006_public_leaderboard.sql.", 503);
      }
      throw normalizeSupabaseError(error, "public leaderboard");
    }
    if (!Array.isArray(data)) throw makeError("Unexpected public leaderboard response.", 500);
    return data;
  }

  function normalizedMobile(value) {
    const mobile = String(value || "").replace(/\D/g, "");
    return /^[6-9]\d{9}$/.test(mobile) ? mobile : null;
  }

  function mobileAuthEmail(mobile) {
    return `${mobile}@members.local`;
  }

  function normalizeSupabaseError(error, operation) {
    const message = String(error.message || "");
    if (/already registered|already exists|duplicate/i.test(message)) {
      return makeError("An account with this mobile number already exists. Choose Login to sign in.", 409);
    }
    if (/invalid login|invalid credentials/i.test(message)) {
      return makeError("Invalid mobile number or password.", 401);
    }
    if (/password.*(weak|short|6)/i.test(message) || /at least 8/i.test(message)) {
      return makeError("Password must contain at least 8 characters.", 400);
    }
    console.error(`Supabase ${operation} failed`, error);
    return makeError(message || `Supabase ${operation} failed.`, 500);
  }

  function normalizeSiteContent(content) {
    if (!content || !["auto", "poster", "slides"].includes(content.bannerMode) ||
        !Array.isArray(content.slides) || content.slides.length > 50 ||
        !content.announcement || typeof content.announcement !== "object") {
      throw makeError("Invalid poster settings.", 400);
    }

    const slides = content.slides.map((slide) => {
      if (!slide || typeof slide !== "object") throw makeError("Each poster must be an object.", 400);
      const image = String(slide.image || "").trim();
      const caption = String(slide.caption || "").trim();
      const tag = String(slide.tag || "").trim();
      let parsedImage;
      try { parsedImage = new URL(image); } catch { throw makeError("Enter a valid poster URL.", 400); }
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
      try { parsedLink = new URL(linkUrl); } catch { throw makeError("Enter a valid announcement link.", 400); }
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

  async function currentMember() {
    await ensureSupabaseReady();
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) {
      if (authError.name === "AuthSessionMissingError") {
        throw makeError("Sign in is required.", 401);
      }
      throw normalizeSupabaseError(authError, "authentication");
    }
    const user = authData.user;
    if (!user) throw makeError("Sign in is required.", 401);

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("display_name,monthly_goal,is_admin")
      .eq("id", user.id)
      .single();
    if (error) throw makeError("Your account profile is missing. Contact the club administrator.", 403);
    return {
      id: user.id,
      name: profile.display_name,
      isAdmin: profile.is_admin === true,
      monthlyGoal: Number(profile.monthly_goal || 30)
    };
  }

  async function apiRequest(path, options) {
    await ensureSupabaseReady();
    const requestOptions = options || {};
    const method = String(requestOptions.method || "GET").toUpperCase();
    const body = requestOptions.body || {};

    try {
      const url = new URL(path, window.location.origin);
      if (url.pathname === "/api/health" && method === "GET") return { status: "ok" };

      if (url.pathname === "/api/auth/register" && method === "POST") {
        const mobile = normalizedMobile(body.mobile);
        const displayName = String(body.displayName || "").trim();
        const password = String(body.password || "");
        if (!mobile) throw makeError("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400);
        if (!displayName || displayName.length > 80) throw makeError("Enter a display name between 1 and 80 characters.", 400);
        if (password.length < 8 || password.length > 128) throw makeError("Password must contain 8 to 128 characters.", 400);

        const { data, error } = await supabase.auth.signUp({
          email: mobileAuthEmail(mobile),
          password,
          options: { data: { display_name: displayName } }
        });
        if (error) throw normalizeSupabaseError(error, "registration");
        if (!data.user) throw makeError("Check the account confirmation setting in Supabase Auth.", 400);
        return currentMember();
      }

      if (url.pathname === "/api/auth/login" && method === "POST") {
        const mobile = normalizedMobile(body.mobile);
        const password = String(body.password || "");
        if (!mobile) throw makeError("Enter a valid 10-digit Indian mobile number starting with 6 to 9.", 400);
        if (!password) throw makeError("Enter your password.", 400);
        const { error } = await supabase.auth.signInWithPassword({
          email: mobileAuthEmail(mobile),
          password
        });
        if (error) throw normalizeSupabaseError(error, "login");
        return currentMember();
      }

      if (url.pathname === "/api/auth/me" && method === "GET") return currentMember();
      if (url.pathname === "/api/auth/logout" && method === "POST") {
        const { error } = await supabase.auth.signOut();
        if (error) throw normalizeSupabaseError(error, "logout");
        return { ok: true };
      }

      if (url.pathname === "/api/settings/me" && method === "PUT") {
        const goal = Number(body.monthlyGoal);
        if (!Number.isFinite(goal) || goal < 5 || goal > 500) {
          throw makeError("Monthly goal must be between 5 and 500 km.", 400);
        }
        const member = await currentMember();
        const roundedGoal = Math.round(goal * 100) / 100;
        const { error } = await supabase.from("profiles")
          .update({ monthly_goal: roundedGoal })
          .eq("id", member.id);
        if (error) throw normalizeSupabaseError(error, "settings update");
        return { monthlyGoal: roundedGoal };
      }

      if (url.pathname === "/api/site-content" && method === "GET") {
        const { data, error } = await supabase.from("site_content").select("content").eq("id", "main").maybeSingle();
        if (error) throw normalizeSupabaseError(error, "site content");
        return data?.content || { ...defaultSiteContent };
      }

      if (url.pathname === "/api/site-content" && method === "PUT") {
        const content = normalizeSiteContent(body);
        const { error } = await supabase.from("site_content").upsert({
          id: "main",
          content,
          updated_at: new Date().toISOString()
        });
        if (error) throw normalizeSupabaseError(error, "site content update");
        return { ok: true };
      }

      throw makeError(`Unsupported Supabase operation: ${method} ${url.pathname}`, 404);
    } catch (error) {
      if (typeof error.status === "number") throw error;
      console.error(`Supabase request failed for ${method} ${url.pathname}`, error);
      throw makeError(error.message || "Supabase request failed.", 500);
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

  function normalizeWalkError(error, operation) {
    if (/gps_path/i.test(String(error.message || "")) &&
        /column|schema cache|could not find/i.test(String(error.message || ""))) {
      console.error(`Supabase ${operation} requires migration 005 for private GPS tracks.`, error);
      return makeError("Private GPS track setup is incomplete. Run supabase/migrations/005_private_gps_tracks.sql.", 503);
    }
    return normalizeSupabaseError(error, operation);
  }

  function walkLogFromRow(row) {
    const createdAt = row.created_at ? Date.parse(row.created_at) : Date.parse(row.date);
    return {
      id: String(row.id),
      memberId: row.member_id,
      name: row.name,
      route: row.route,
      km: Number(row.km),
      mins: Number(row.mins),
      date: row.date,
      createdAt,
      gpsPath: normalizeGpsPath(row.gps_path)
    };
  }

  async function loadWalkPage(cursor, memberId) {
    let query = supabase.from("walk_logs")
      .select("id,member_id,name,route,km,mins,date,created_at,gps_path")
      .eq("member_id", memberId)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(walkPageSize + 1);
    if (cursor) query = query.range(cursor, cursor + walkPageSize);
    const { data, error } = await query;
    if (error) throw normalizeWalkError(error, "walk history");
    const visibleRows = data.slice(0, walkPageSize);
    const nextCursor = cursor ? cursor + walkPageSize : walkPageSize;
    walkLogCursor = nextCursor;
    walkLogsHaveMore = data.length > walkPageSize;
    return { items: visibleRows.map(walkLogFromRow), hasMore: walkLogsHaveMore };
  }

  async function loadLogs() {
    await ensureSupabaseReady();
    walkLogCursor = null;
    walkLogMemberId = null;
    walkLogsHaveMore = false;
    let member;
    try {
      member = await currentMember();
    } catch (error) {
      if (error.status === 401) return { items: [], hasMore: false };
      throw error;
    }
    walkLogMemberId = member.id;
    return loadWalkPage(null, member.id);
  }

  async function loadMoreLogs() {
    await ensureSupabaseReady();
    if (!walkLogCursor || !walkLogsHaveMore || !walkLogMemberId) {
      return { items: [], hasMore: false };
    }
    let member;
    try {
      member = await currentMember();
    } catch (error) {
      if (error.status === 401) {
        walkLogCursor = null;
        walkLogMemberId = null;
        walkLogsHaveMore = false;
        return { items: [], hasMore: false };
      }
      throw error;
    }
    if (member.id !== walkLogMemberId) return loadLogs();
    return loadWalkPage(walkLogCursor, member.id);
  }

  async function loadAllLogs() {
    await ensureSupabaseReady();
    let member;
    try {
      member = await currentMember();
    } catch (error) {
      if (error.status === 401) return [];
      throw error;
    }
    const rows = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase.from("walk_logs")
        .select("id,member_id,name,route,km,mins,date,created_at,gps_path")
        .eq("member_id", member.id)
        .order("date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, from + walkPageSize - 1);
      if (error) throw normalizeWalkError(error, "walk export");
      rows.push(...data);
      if (data.length < walkPageSize) return rows.map(walkLogFromRow);
      from += walkPageSize;
    }
  }

  async function createWalk(log) {
    await ensureSupabaseReady();
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
    const { data, error } = await supabase.from("walk_logs").insert({
      member_id: member.id,
      name: member.name,
      route,
      km: Math.round(distance * 100) / 100,
      mins: minutes,
      date,
      gps_path: gpsPath
    }).select("id").single();
    if (error) throw normalizeWalkError(error, "walk creation");
    return { id: String(data.id) };
  }

  window.PWCSupabase = {
    apiRequest,
    getWeeklyTopper,
    getPublicLeaderboard,
    loadLogs,
    loadMoreLogs,
    loadAllLogs,
    createWalk
  };
})();
