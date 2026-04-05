/**
 * Macro Tracker - Indian Food Edition
 * Main Application JavaScript
 * 
 * Features:
 * - IndexedDB storage via Dexie.js
 * - Maharashtrian food database
 * - Dual-unit input (grams / common units)
 * - Smart nutritional insights
 * - Weight tracking with trends
 * - Chart.js visualizations
 * - JSON export/import
 */

// ===== DATABASE SETUP =====

/** Bump when data/indb-foods.json is regenerated so clients merge new rows. */
const INDB_BUNDLE_VERSION = 1;

function starterKey(name) {
    return 'starter:' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function mapStarterFoodForSeed(f) {
    const key = starterKey(f.name);
    return { ...f, source: 'starter', externalKey: key, syncId: key };
}

/**
 * Per-user IndexedDB (separate data for each Supabase account on this device).
 * Legacy DB name `MacroTrackerDB` is no longer used after auth became required.
 */
let db = null;
let activeAuthUserId = null;

function createDexieForUser(userId) {
    const safeId = String(userId).replace(/[^a-zA-Z0-9-]/g, '');
    const d = new Dexie(`MacroTracker_${safeId}`);
    d.version(2).stores({
        foods: '++id, name, category, source, externalKey, syncId',
        logs: '++id, date, foodId, mealType, foodSyncId',
        userSettings: 'id',
        weightLogs: '++id, date',
        meta: 'key'
    });
    return d;
}

async function openDatabaseForUser(userId) {
    if (activeAuthUserId === userId && db) return db;
    if (db) {
        await db.close();
        db = null;
    }
    db = createDexieForUser(userId);
    activeAuthUserId = userId;
    await db.open();
    return db;
}

async function closeUserDatabase() {
    if (db) await db.close();
    db = null;
    activeAuthUserId = null;
}

// ===== SUPABASE (optional; config.js) =====
let supabaseClient = null;

function getSupabase() {
    if (supabaseClient) return supabaseClient;
    const cfg = typeof window !== 'undefined' ? window.MACRO_TRACKER_CONFIG : null;
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return null;
    if (typeof window.supabase === 'undefined' || !window.supabase?.createClient) return null;
    supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return supabaseClient;
}

let syncDebounceTimer = null;
let mainAppListenersBound = false;
let appBootPromise = null;
let lastBootedUserId = null;

async function buildSyncPayload() {
    const userFoods = await db.foods.filter((f) => f.source === 'user').toArray();
    const logs = await db.logs.toArray();
    const weightLogs = await db.weightLogs.toArray();
    const userSettings = await db.userSettings.toArray();
    return {
        version: 1,
        foods: userFoods.map(({ id, ...rest }) => rest),
        logs: logs.map(({ id, ...rest }) => rest),
        weightLogs: weightLogs.map(({ id, ...rest }) => rest),
        userSettings
    };
}

async function applyRemotePayload(remotePayload, remoteUpdatedAt) {
    const foods = remotePayload.foods || [];
    const logs = remotePayload.logs || [];
    const weightLogs = remotePayload.weightLogs || [];
    const userSettings = remotePayload.userSettings || [];
    const prevSettings = await db.userSettings.get(1);
    const preservedFileHandleName = prevSettings?.fileHandleName;

    await db.transaction('rw', db.foods, db.logs, db.weightLogs, db.userSettings, db.meta, async () => {
        const toDelete = await db.foods.filter((f) => f.source === 'user').toArray();
        for (const f of toDelete) await db.foods.delete(f.id);

        const syncIdToLocalId = new Map();
        for (const f of foods) {
            const { id: _ignore, ...rest } = f;
            const newId = await db.foods.add({
                ...rest,
                source: 'user',
                isDefault: false,
                syncId: rest.syncId || crypto.randomUUID(),
                externalKey: rest.externalKey || `user:${crypto.randomUUID()}`
            });
            syncIdToLocalId.set(rest.syncId, newId);
        }

        // Logs often reference catalog foods (starter / INDB); those are not in the cloud payload,
        // but they already exist locally with the same syncId after initializeDatabase + catalog merge.
        const catalogFoods = await db.foods.filter((x) => x.source !== 'user').toArray();
        for (const cf of catalogFoods) {
            if (cf.syncId != null && cf.syncId !== '') {
                syncIdToLocalId.set(cf.syncId, cf.id);
            }
        }

        await db.logs.clear();
        for (const log of logs) {
            const fid = syncIdToLocalId.get(log.foodSyncId);
            if (fid == null) continue;
            await db.logs.add({
                date: log.date,
                foodId: fid,
                quantity: log.quantity,
                unitLabel: log.unitLabel,
                unitWeight: log.unitWeight,
                mealType: log.mealType,
                foodSyncId: log.foodSyncId
            });
        }

        await db.weightLogs.clear();
        for (const w of weightLogs) {
            await db.weightLogs.add({ date: w.date, weight: w.weight });
        }

        await db.userSettings.clear();
        for (const s of userSettings) {
            const row = s.id === 1 ? { ...s, fileHandleName: s.fileHandleName ?? preservedFileHandleName } : s;
            await db.userSettings.put(row);
        }

        await db.meta.put({ key: 'cloudSyncCursor', value: remoteUpdatedAt });
    });

    const settings = await db.userSettings.get(1);
    if (settings?.dailyGoals) {
        userGoals = settings.dailyGoals;
        document.getElementById('goal-calories').value = userGoals.calories;
        document.getElementById('goal-protein').value = userGoals.protein;
        document.getElementById('goal-carbs').value = userGoals.carbs;
        document.getElementById('goal-fats').value = userGoals.fats;
    }
}

async function pullFromSupabase(force = false) {
    if (!db) return;
    const client = getSupabase();
    if (!client) return;
    const { data: { session } } = await client.auth.getSession();
    if (!session) return;

    const { data, error } = await client
        .from('user_data')
        .select('payload, updated_at')
        .eq('user_id', session.user.id)
        .maybeSingle();

    if (error) {
        console.error('Supabase pull error', error);
        return;
    }
    if (!data?.payload) return;

    const cursorRow = await db.meta.get('cloudSyncCursor');
    const cursor = cursorRow?.value || null;
    const logsCount = await db.logs.count();

    if (!force) {
        if (!cursor && logsCount > 0) {
            showToast('Local logs kept — use Pull from cloud to overwrite with server', 'warning');
            return;
        }
        if (cursor && data.updated_at && new Date(data.updated_at) <= new Date(cursor)) return;
    }

    await applyRemotePayload(data.payload, data.updated_at);
    showToast('Synced from cloud', 'success');
    await loadDayLogs();
    renderFoodLibraryFromUi();
}

async function pushToSupabase() {
    if (!db) return;
    const client = getSupabase();
    if (!client) return;
    const { data: { session } } = await client.auth.getSession();
    if (!session) return;

    const payload = await buildSyncPayload();
    const updated_at = new Date().toISOString();

    const { error } = await client.from('user_data').upsert(
        { user_id: session.user.id, payload, updated_at },
        { onConflict: 'user_id' }
    );

    if (error) {
        console.error('Supabase push error', error);
        updateSyncStatusUI('Error saving to cloud', true);
        return;
    }

    await db.meta.put({ key: 'cloudSyncCursor', value: updated_at });
    updateSyncStatusUI(`Last saved: ${new Date(updated_at).toLocaleString()}`, false);
}

function scheduleCloudSync() {
    if (!db) return;
    const client = getSupabase();
    if (!client) return;
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        pushToSupabase();
    }, 2000);
}

function updateSyncStatusUI(message, isError) {
    const el = document.getElementById('sync-status-text');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('text-danger', !!isError);
}

async function mergeIndbCatalogFromNetwork(force = false) {
    const meta = await db.meta.get('catalogBundleVersion');
    const current = meta?.value ?? 0;
    if (!force && current >= INDB_BUNDLE_VERSION) return;

    let list;
    try {
        const res = await fetch('./data/indb-foods.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        list = await res.json();
    } catch (e) {
        console.warn('INDB catalog fetch failed', e);
        return;
    }

    const existingIndb = await db.foods.filter((f) => f.source === 'indb').toArray();
    const byKey = new Map(existingIndb.map((f) => [f.externalKey, f]));

    for (const item of list) {
        const row = {
            name: item.name,
            protein: item.protein,
            carbs: item.carbs,
            fats: item.fats,
            calories: item.calories,
            category: 'indb',
            servingOptions: item.servingOptions || [{ label: '100g', weight: 100 }],
            isDefault: true,
            source: 'indb',
            externalKey: item.externalKey,
            syncId: item.externalKey
        };
        const prev = byKey.get(item.externalKey);
        if (prev) await db.foods.update(prev.id, row);
        else await db.foods.add(row);
    }

    await db.meta.put({ key: 'catalogBundleVersion', value: INDB_BUNDLE_VERSION });
}

// ===== MAHARASHTRIAN STARTER PACK DATA =====

/**
 * Pre-loaded Maharashtrian food database
 * All values are per 100g
 */
const STARTER_PACK_FOODS = [
    // Vegetarian Dishes
    {
        name: 'Pithla',
        protein: 8.5,
        carbs: 14,
        fats: 6,
        calories: 145,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Serving (200g)', weight: 200 }
        ],
        isDefault: true
    },
    {
        name: 'Batata Bhaji',
        protein: 2,
        carbs: 18,
        fats: 7,
        calories: 143,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Serving (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Varana (Plain Dal)',
        protein: 7,
        carbs: 20,
        fats: 2.5,
        calories: 130,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Bowl (200g)', weight: 200 }
        ],
        isDefault: true
    },
    {
        name: 'Amti',
        protein: 6.5,
        carbs: 18,
        fats: 5,
        calories: 140,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Bowl (200g)', weight: 200 }
        ],
        isDefault: true
    },
    {
        name: 'Sabudana Khichdi',
        protein: 1.5,
        carbs: 35,
        fats: 8,
        calories: 215,
        category: 'veg',
        servingOptions: [
            { label: '1 Plate (150g)', weight: 150 },
            { label: '1 Katori (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Vangyache Bharit (Baingan Bharta)',
        protein: 2.5,
        carbs: 8,
        fats: 9,
        calories: 120,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Serving (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Usal (Sprouted Beans)',
        protein: 9,
        carbs: 22,
        fats: 4,
        calories: 158,
        category: 'veg',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Bowl (200g)', weight: 200 }
        ],
        isDefault: true
    },
    {
        name: 'Kanda Poha',
        protein: 3,
        carbs: 28,
        fats: 6,
        calories: 180,
        category: 'veg',
        servingOptions: [
            { label: '1 Plate (150g)', weight: 150 },
            { label: '1 Katori (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Misal Pav (Misal only)',
        protein: 8,
        carbs: 20,
        fats: 7,
        calories: 175,
        category: 'veg',
        servingOptions: [
            { label: '1 Plate (200g)', weight: 200 },
            { label: '1 Katori (150g)', weight: 150 }
        ],
        isDefault: true
    },
    {
        name: 'Thalipeeth',
        protein: 4,
        carbs: 22,
        fats: 5,
        calories: 148,
        category: 'veg',
        servingOptions: [
            { label: '1 Medium (80g)', weight: 80 },
            { label: '1 Large (100g)', weight: 100 }
        ],
        isDefault: true
    },
    
    // Non-Vegetarian Dishes
    {
        name: 'Chicken Rassa',
        protein: 18,
        carbs: 6,
        fats: 12,
        calories: 200,
        category: 'non-veg',
        servingOptions: [
            { label: '1 Bowl (250g)', weight: 250 },
            { label: '1 Katori (150g)', weight: 150 },
            { label: '2 Pieces with gravy (200g)', weight: 200 }
        ],
        isDefault: true
    },
    {
        name: 'Egg Curry',
        protein: 11,
        carbs: 5,
        fats: 14,
        calories: 185,
        category: 'non-veg',
        servingOptions: [
            { label: '2 Eggs with gravy (200g)', weight: 200 },
            { label: '1 Egg with gravy (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Mutton Sukka',
        protein: 25,
        carbs: 4,
        fats: 18,
        calories: 280,
        category: 'non-veg',
        servingOptions: [
            { label: '1 Serving (150g)', weight: 150 },
            { label: '1 Katori (100g)', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Fish Fry (Bangda)',
        protein: 22,
        carbs: 8,
        fats: 15,
        calories: 255,
        category: 'non-veg',
        servingOptions: [
            { label: '1 Medium Fish (120g)', weight: 120 },
            { label: '2 Pieces (150g)', weight: 150 }
        ],
        isDefault: true
    },
    {
        name: 'Kombdi Vade',
        protein: 16,
        carbs: 10,
        fats: 14,
        calories: 230,
        category: 'non-veg',
        servingOptions: [
            { label: '1 Bowl (200g)', weight: 200 },
            { label: '1 Katori (150g)', weight: 150 }
        ],
        isDefault: true
    },
    {
        name: 'Boiled Egg',
        protein: 13,
        carbs: 1.1,
        fats: 11,
        calories: 155,
        category: 'non-veg',
        servingOptions: [
            { label: '1 Egg (50g)', weight: 50 },
            { label: '2 Eggs (100g)', weight: 100 }
        ],
        isDefault: true
    },
    
    // Breads
    {
        name: 'Chapati / Poli',
        protein: 3,
        carbs: 18,
        fats: 1.5,
        calories: 97,
        category: 'breads',
        servingOptions: [
            { label: '1 Medium (40g)', weight: 40 },
            { label: '1 Large (50g)', weight: 50 }
        ],
        isDefault: true
    },
    {
        name: 'Jowar Bhakri',
        protein: 3.5,
        carbs: 25,
        fats: 1.2,
        calories: 125,
        category: 'breads',
        servingOptions: [
            { label: '1 Medium (60g)', weight: 60 },
            { label: '1 Large (80g)', weight: 80 }
        ],
        isDefault: true
    },
    {
        name: 'Bajra Bhakri',
        protein: 3.8,
        carbs: 24,
        fats: 1.5,
        calories: 125,
        category: 'breads',
        servingOptions: [
            { label: '1 Medium (60g)', weight: 60 },
            { label: '1 Large (80g)', weight: 80 }
        ],
        isDefault: true
    },
    {
        name: 'Rice (Cooked)',
        protein: 2.7,
        carbs: 28,
        fats: 0.3,
        calories: 130,
        category: 'breads',
        servingOptions: [
            { label: '1 Katori (150g)', weight: 150 },
            { label: '1 Plate (200g)', weight: 200 },
            { label: '100g', weight: 100 }
        ],
        isDefault: true
    },
    {
        name: 'Pav',
        protein: 3.5,
        carbs: 24,
        fats: 2,
        calories: 130,
        category: 'breads',
        servingOptions: [
            { label: '1 Pav (40g)', weight: 40 },
            { label: '2 Pav (80g)', weight: 80 }
        ],
        isDefault: true
    },
    {
        name: 'Puran Poli',
        protein: 4,
        carbs: 45,
        fats: 6,
        calories: 250,
        category: 'breads',
        servingOptions: [
            { label: '1 Medium (80g)', weight: 80 },
            { label: '1 Large (100g)', weight: 100 }
        ],
        isDefault: true
    },
    
    // Protein Supplements
    {
        name: 'Whey Protein',
        protein: 75,
        carbs: 8,
        fats: 4,
        calories: 380,
        category: 'supplements',
        servingOptions: [
            { label: '1 Scoop (33g)', weight: 33 },
            { label: '1.5 Scoops (50g)', weight: 50 }
        ],
        isDefault: true
    },
    {
        name: 'Casein Protein',
        protein: 80,
        carbs: 4,
        fats: 2,
        calories: 360,
        category: 'supplements',
        servingOptions: [
            { label: '1 Scoop (30g)', weight: 30 }
        ],
        isDefault: true
    },
    {
        name: 'Plant Protein',
        protein: 70,
        carbs: 10,
        fats: 6,
        calories: 390,
        category: 'supplements',
        servingOptions: [
            { label: '1 Scoop (35g)', weight: 35 }
        ],
        isDefault: true
    },
    
    // Running Supplements
    {
        name: 'Energy Gel',
        protein: 0,
        carbs: 22,
        fats: 0,
        calories: 90,
        category: 'running-supps',
        servingOptions: [
            { label: '1 Gel (32g)', weight: 32 }
        ],
        isDefault: true
    },
    {
        name: 'Carb Powder / Isotonic',
        protein: 0,
        carbs: 95,
        fats: 0,
        calories: 380,
        category: 'running-supps',
        servingOptions: [
            { label: '1 Serving (50g)', weight: 50 },
            { label: '1 Scoop (25g)', weight: 25 }
        ],
        isDefault: true
    },
    {
        name: 'Energy Bar',
        protein: 5,
        carbs: 45,
        fats: 8,
        calories: 270,
        category: 'running-supps',
        servingOptions: [
            { label: '1 Bar (60g)', weight: 60 }
        ],
        isDefault: true
    }
];

// Default user goals
const DEFAULT_GOALS = {
    calories: 2000,
    protein: 120,
    carbs: 250,
    fats: 65
};

// ===== GLOBAL STATE =====
let currentMealType = 'breakfast';
let selectedFood = null;
let userGoals = { ...DEFAULT_GOALS };
let charts = {
    weight: null,
    macroPie: null,
    calorieTrend: null
};

function destroyCharts() {
    Object.keys(charts).forEach((k) => {
        if (charts[k]?.destroy) charts[k].destroy();
        charts[k] = null;
    });
}

// File System Access API state
let fileHandle = null;
let isFileStorageActive = false;
let autoSaveTimeout = null;

// Date navigation state
let selectedDate = null; // Initialized in DOMContentLoaded

// ===== UTILITY FUNCTIONS =====

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

/**
 * Format date for display
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-IN', { 
        weekday: 'short', 
        day: 'numeric', 
        month: 'short' 
    });
}

/**
 * Format date for display with year (for non-current year)
 */
function formatDateFull(dateString) {
    const date = new Date(dateString);
    const today = new Date();
    const options = { 
        weekday: 'short', 
        day: 'numeric', 
        month: 'short'
    };
    if (date.getFullYear() !== today.getFullYear()) {
        options.year = 'numeric';
    }
    return date.toLocaleDateString('en-IN', options);
}

/**
 * Check if selected date is today
 */
function isToday(dateString) {
    return dateString === getTodayDate();
}

/**
 * Navigate to previous day
 */
function goToPreviousDay() {
    const date = new Date(selectedDate);
    date.setDate(date.getDate() - 1);
    selectedDate = date.toISOString().split('T')[0];
    updateDateDisplay();
    loadDayLogs();
}

/**
 * Navigate to next day
 */
function goToNextDay() {
    const date = new Date(selectedDate);
    date.setDate(date.getDate() + 1);
    // Don't allow going beyond today
    const today = getTodayDate();
    if (date.toISOString().split('T')[0] <= today) {
        selectedDate = date.toISOString().split('T')[0];
        updateDateDisplay();
        loadDayLogs();
    }
}

/**
 * Go to today
 */
function goToToday() {
    selectedDate = getTodayDate();
    updateDateDisplay();
    loadDayLogs();
}

/**
 * Set specific date
 */
function setDate(dateString) {
    const today = getTodayDate();
    if (dateString <= today) {
        selectedDate = dateString;
        updateDateDisplay();
        loadDayLogs();
    }
}

/**
 * Update date display in UI
 */
function updateDateDisplay() {
    const dateText = document.getElementById('selected-date-text');
    const todayBtn = document.getElementById('go-to-today-btn');
    const nextBtn = document.getElementById('next-day-btn');
    const datePicker = document.getElementById('date-picker');
    const tabToday = document.getElementById('tab-today');
    
    if (datePicker) {
        datePicker.value = selectedDate;
    }
    
    if (isToday(selectedDate)) {
        dateText.textContent = 'Today';
        todayBtn.classList.add('hidden');
        nextBtn.disabled = true;
        nextBtn.classList.add('opacity-30');
        tabToday?.classList.remove('viewing-past-day');
    } else {
        dateText.textContent = formatDateFull(selectedDate);
        todayBtn.classList.remove('hidden');
        nextBtn.disabled = false;
        nextBtn.classList.remove('opacity-30');
        tabToday?.classList.add('viewing-past-day');
    }
    
    // Update header date
    document.getElementById('header-date').textContent = isToday(selectedDate) ? 'Today' : formatDate(selectedDate);
}

/**
 * Calculate macro values based on the formula:
 * Total_Macro = (Serving_Size × Multiplier / 100) × Macro_Per_100g
 */
function calculateMacros(food, quantity, unitWeight) {
    const multiplier = quantity;
    const servingSize = unitWeight;
    
    return {
        calories: Math.round((servingSize * multiplier / 100) * food.calories),
        protein: Math.round((servingSize * multiplier / 100) * food.protein * 10) / 10,
        carbs: Math.round((servingSize * multiplier / 100) * food.carbs * 10) / 10,
        fats: Math.round((servingSize * multiplier / 100) * food.fats * 10) / 10
    };
}

/**
 * Show toast notification
 */
function showToast(message, type = 'default') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toast-message');
    
    toastMessage.textContent = message;
    toast.className = `fixed bottom-28 md:bottom-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-xl shadow-lg z-50 transition-all duration-300 ${type}`;
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

/**
 * Debounce function for search input
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function buildFoodLookups(foods) {
    const foodMap = new Map(foods.map((f) => [f.id, f]));
    const foodBySync = new Map(foods.filter((f) => f.syncId).map((f) => [f.syncId, f]));
    return { foodMap, foodBySync };
}

function resolveFoodForLog(log, foodMap, foodBySync) {
    return foodMap.get(log.foodId) || (log.foodSyncId ? foodBySync.get(log.foodSyncId) : undefined);
}

// ===== FILE SYSTEM ACCESS API =====

/**
 * Check if File System Access API is supported
 */
function isFileSystemAccessSupported() {
    return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

/**
 * Update the storage status UI
 */
function updateStorageStatusUI() {
    const indicator = document.getElementById('storage-indicator');
    const statusText = document.getElementById('storage-status-text');
    const filePath = document.getElementById('storage-file-path');
    const disconnectBtn = document.getElementById('disconnect-storage-btn');
    const setStorageBtn = document.getElementById('set-storage-file-btn');
    
    if (isFileStorageActive && fileHandle) {
        indicator.className = 'w-3 h-3 rounded-full bg-success animate-pulse';
        statusText.textContent = 'Connected to local file';
        filePath.textContent = `📁 ${fileHandle.name}`;
        filePath.classList.remove('hidden');
        disconnectBtn.classList.remove('hidden');
        setStorageBtn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Change Storage File
        `;
    } else {
        indicator.className = 'w-3 h-3 rounded-full bg-gray-400';
        statusText.textContent = 'No file selected (using browser storage)';
        filePath.classList.add('hidden');
        disconnectBtn.classList.add('hidden');
        setStorageBtn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
            Choose Storage File
        `;
    }
}

/**
 * Collect all data from IndexedDB for saving
 */
async function collectAllData() {
    return {
        version: 1,
        exportDate: new Date().toISOString(),
        foods: await db.foods.toArray(),
        logs: await db.logs.toArray(),
        weightLogs: await db.weightLogs.toArray(),
        userSettings: await db.userSettings.toArray()
    };
}

/**
 * Save data to the connected file
 */
async function saveToFile() {
    if (!isFileStorageActive || !fileHandle) return;
    
    try {
        const data = await collectAllData();
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(data, null, 2));
        await writable.close();
        
        console.log('Data saved to file:', fileHandle.name);
        
        // Flash the indicator to show save
        const indicator = document.getElementById('storage-indicator');
        indicator.classList.add('scale-125');
        setTimeout(() => indicator.classList.remove('scale-125'), 200);
        
    } catch (error) {
        console.error('Error saving to file:', error);
        // If permission was revoked, disconnect
        if (error.name === 'NotAllowedError') {
            disconnectFileStorage();
            showToast('File access revoked. Reconnect to continue saving.', 'warning');
        }
    }
}

/**
 * Auto-save with debounce to prevent too many writes
 */
function triggerAutoSave() {
    scheduleCloudSync();

    if (!isFileStorageActive) return;

    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }

    autoSaveTimeout = setTimeout(() => {
        saveToFile();
    }, 1000);
}

/**
 * Load data from a file
 */
async function loadFromFile(handle) {
    try {
        const file = await handle.getFile();
        const text = await file.text();
        const data = JSON.parse(text);
        
        if (!data.version || !data.foods) {
            throw new Error('Invalid file format');
        }
        
        return data;
    } catch (error) {
        console.error('Error reading file:', error);
        throw error;
    }
}

function normalizeImportedFoodRow(f) {
    const source = f.source || (f.isDefault ? 'starter' : 'user');
    let externalKey = f.externalKey;
    let syncId = f.syncId;
    if (!externalKey) {
        if (source === 'starter') externalKey = starterKey(f.name);
        else if (source === 'user') externalKey = `user:import:${f.name}:${Math.random()}`;
        else externalKey = `import:${f.name}`;
    }
    if (!syncId) {
        if (source === 'starter') syncId = starterKey(f.name);
        else if (source === 'user') syncId = crypto.randomUUID();
        else syncId = externalKey;
    }
    return { ...f, source, externalKey, syncId };
}

/**
 * Import data into IndexedDB (full replace)
 */
async function importDataToDb(data) {
    await db.foods.clear();
    await db.logs.clear();
    await db.weightLogs.clear();
    await db.userSettings.clear();

    if (data.foods?.length) {
        const rows = data.foods.map(normalizeImportedFoodRow);
        await db.foods.bulkAdd(rows);
    }
    if (data.logs?.length) await db.logs.bulkAdd(data.logs);
    if (data.weightLogs?.length) await db.weightLogs.bulkAdd(data.weightLogs);
    if (data.userSettings?.length) await db.userSettings.bulkAdd(data.userSettings);

    const foodsArr = await db.foods.toArray();
    const byId = new Map(foodsArr.map((x) => [x.id, x]));
    const logs = await db.logs.toArray();
    for (const log of logs) {
        const food = byId.get(log.foodId);
        if (food?.syncId && !log.foodSyncId) await db.logs.update(log.id, { foodSyncId: food.syncId });
    }

    await mergeIndbCatalogFromNetwork(true);

    const settings = await db.userSettings.get(1);
    if (settings) {
        userGoals = settings.dailyGoals;
        document.getElementById('goal-calories').value = userGoals.calories;
        document.getElementById('goal-protein').value = userGoals.protein;
        document.getElementById('goal-carbs').value = userGoals.carbs;
        document.getElementById('goal-fats').value = userGoals.fats;
    }
}

/**
 * Set up file storage - let user pick a file
 */
async function setupFileStorage() {
    if (!isFileSystemAccessSupported()) {
        showToast('Your browser doesn\'t support local file storage. Try Chrome or Edge.', 'warning');
        return;
    }
    
    try {
        // Let user pick or create a file
        const handle = await window.showSaveFilePicker({
            suggestedName: 'macro-tracker-data.json',
            types: [{
                description: 'JSON Data',
                accept: { 'application/json': ['.json'] }
            }]
        });
        
        fileHandle = handle;
        
        // Check if file has existing data
        try {
            const file = await handle.getFile();
            if (file.size > 0) {
                const text = await file.text();
                const data = JSON.parse(text);
                
                if (data.foods && data.foods.length > 0) {
                    // Ask user if they want to load existing data
                    if (confirm('This file contains existing data. Load it? (Cancel to overwrite with current data)')) {
                        await importDataToDb(data);
                        showToast('Data loaded from file!', 'success');
                    }
                }
            }
        } catch (e) {
            // File is empty or new, that's fine
        }
        
        // Save current data to file
        isFileStorageActive = true;
        await saveToFile();
        
        // Store handle reference in IndexedDB for reconnection
        await db.userSettings.update(1, { fileHandleName: handle.name });
        
        updateStorageStatusUI();
        showToast(`Connected to ${handle.name}`, 'success');
        
        // Refresh UI
        loadDayLogs();
        renderFoodLibraryFromUi();
        
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error setting up file storage:', error);
            showToast('Error setting up file storage', 'error');
        }
    }
}

/**
 * Disconnect from file storage
 */
async function disconnectFileStorage() {
    fileHandle = null;
    isFileStorageActive = false;
    
    // Remove stored handle reference
    await db.userSettings.update(1, { fileHandleName: null });
    
    updateStorageStatusUI();
    showToast('Disconnected from file. Using browser storage.', 'success');
}

/**
 * Create initial data file with current logs
 */
async function createInitialDataFile() {
    const data = await collectAllData();
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `macro-tracker-data.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ===== DATABASE INITIALIZATION =====

/**
 * Initialize database with starter pack (only on first run) and INDB catalog merge
 */
async function initializeDatabase() {
    try {
        const foodCount = await db.foods.count();

        if (foodCount === 0) {
            const starterRows = STARTER_PACK_FOODS.map(mapStarterFoodForSeed);
            await db.foods.bulkAdd(starterRows);
            console.log('Maharashtrian Starter Pack loaded successfully!');
        }

        await mergeIndbCatalogFromNetwork();

        const settings = await db.userSettings.get(1);
        if (!settings) {
            await db.userSettings.put({
                id: 1,
                dailyGoals: DEFAULT_GOALS
            });
        } else {
            userGoals = settings.dailyGoals;
        }

        document.getElementById('goal-calories').value = userGoals.calories;
        document.getElementById('goal-protein').value = userGoals.protein;
        document.getElementById('goal-carbs').value = userGoals.carbs;
        document.getElementById('goal-fats').value = userGoals.fats;
    } catch (error) {
        console.error('Database initialization error:', error);
        showToast('Error initializing database', 'error');
    }
}

// ===== TAB NAVIGATION =====

/**
 * Switch between tabs
 */
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
    
    // Load tab-specific data
    if (tabName === 'analysis') {
        loadAnalysisData();
    } else if (tabName === 'library') {
        renderFoodLibraryFromUi();
    }
}

// ===== FOOD LIBRARY =====

/**
 * Render food library with search and filter
 */
async function renderFoodLibrary(searchTerm = '', category = 'all') {
    const foodList = document.getElementById('food-list');
    
    try {
        let foods = await db.foods.toArray();
        
        // Filter by search term
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            foods = foods.filter(food => food.name.toLowerCase().includes(term));
        }
        
        // Filter by category
        if (category !== 'all') {
            foods = foods.filter(food => food.category === category);
        }
        
        // Sort alphabetically
        foods.sort((a, b) => a.name.localeCompare(b.name));
        
        if (foods.length === 0) {
            foodList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🍽️</div>
                    <p>No foods found</p>
                    <p class="text-sm">Try a different search or add a custom dish</p>
                </div>
            `;
            return;
        }
        
        foodList.innerHTML = foods.map(food => `
            <div class="food-item food-card" data-food-id="${food.id}">
                <div class="food-item-info">
                    <div class="food-item-name">${food.name}</div>
                    <div class="food-item-macros">
                        ${food.calories} kcal · P: ${food.protein}g · C: ${food.carbs}g · F: ${food.fats}g
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="food-item-category">${getCategoryLabel(food.category)}</span>
                    <button class="edit-food-btn p-2 text-warm-gray hover:text-deep-green" data-food-id="${food.id}">
                        ✏️
                    </button>
                </div>
            </div>
        `).join('');
        
        // Add click handlers for editing custom foods
        document.querySelectorAll('.edit-food-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditFoodModal(parseInt(btn.dataset.foodId));
            });
        });
        
    } catch (error) {
        console.error('Error rendering food library:', error);
        foodList.innerHTML = '<p class="text-danger text-center">Error loading foods</p>';
    }
}

function getLibrarySearchTerm() {
    return document.getElementById('food-search')?.value?.trim() || '';
}

function getActiveLibraryCategory() {
    return document.querySelector('.category-btn.active')?.dataset.category || 'all';
}

/** Re-render library using the current search box + category chip (keeps UI and list in sync). */
async function renderFoodLibraryFromUi() {
    await renderFoodLibrary(getLibrarySearchTerm(), getActiveLibraryCategory());
}

/** Update category chips; unknown values fall back to All. */
function setFoodLibraryCategoryFilter(category) {
    const buttons = document.querySelectorAll('.category-btn');
    const valid = [...buttons].some((b) => b.dataset.category === category);
    const cat = valid ? category : 'all';
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.category === cat));
}

/**
 * Get category display label
 */
function getCategoryLabel(category) {
    const labels = {
        'veg': '🥬 Veg',
        'non-veg': '🍗 Non-Veg',
        'breads': '🫓 Breads',
        'supplements': '🥤 Protein',
        'running-supps': '🏃 Running',
        'custom': '⭐ Custom',
        'indb': '📗 INDB'
    };
    return labels[category] || category;
}

// ===== FOOD LOGGING =====

/**
 * Load and display logged foods for the selected date
 */
async function loadDayLogs() {
    const dateToLoad = selectedDate || getTodayDate();
    
    try {
        const logs = await db.logs.where('date').equals(dateToLoad).toArray();
        const foods = await db.foods.toArray();
        const { foodMap, foodBySync } = buildFoodLookups(foods);

        // Group logs by meal type
        const mealLogs = {
            breakfast: [],
            lunch: [],
            dinner: [],
            snacks: []
        };
        
        let totals = { calories: 0, protein: 0, carbs: 0, fats: 0 };
        
        logs.forEach(log => {
            const food = resolveFoodForLog(log, foodMap, foodBySync);
            if (food) {
                const macros = calculateMacros(food, log.quantity, log.unitWeight);
                mealLogs[log.mealType].push({
                    ...log,
                    food,
                    macros
                });
                
                totals.calories += macros.calories;
                totals.protein += macros.protein;
                totals.carbs += macros.carbs;
                totals.fats += macros.fats;
            }
        });
        
        // Render each meal section
        Object.keys(mealLogs).forEach(mealType => {
            renderMealSection(mealType, mealLogs[mealType]);
        });
        
        // Update progress bars
        updateProgressBars(totals);
        
        // Update header calories
        document.getElementById('header-calories').textContent = 
            `${Math.round(totals.calories)} / ${userGoals.calories} kcal`;
        
        // Generate insights
        generateInsights(totals, logs.length);
        
    } catch (error) {
        console.error('Error loading today logs:', error);
    }
}

/**
 * Render meal section with logged items
 */
function renderMealSection(mealType, items) {
    const container = document.getElementById(`meal-${mealType}`);
    
    if (items.length === 0) {
        container.innerHTML = '<p class="text-warm-gray text-sm text-center py-2">No items logged</p>';
        return;
    }
    
    container.innerHTML = items.map(item => `
        <div class="logged-item" data-log-id="${item.id}">
            <div class="logged-item-info">
                <div class="logged-item-name">${item.food.name}</div>
                <div class="logged-item-details">
                    ${item.quantity} × ${item.unitLabel} · ${item.macros.calories} kcal
                </div>
            </div>
            <button class="logged-item-delete" onclick="deleteLog(${item.id})">
                🗑️
            </button>
        </div>
    `).join('');
}

/**
 * Update progress bars with current totals
 */
function updateProgressBars(totals) {
    // Calculate percentages
    const percentages = {
        calories: Math.min((totals.calories / userGoals.calories) * 100, 100),
        protein: Math.min((totals.protein / userGoals.protein) * 100, 100),
        carbs: Math.min((totals.carbs / userGoals.carbs) * 100, 100),
        fats: Math.min((totals.fats / userGoals.fats) * 100, 100)
    };
    
    // Update bars and text
    document.getElementById('progress-calories').style.width = `${percentages.calories}%`;
    document.getElementById('progress-protein').style.width = `${percentages.protein}%`;
    document.getElementById('progress-carbs').style.width = `${percentages.carbs}%`;
    document.getElementById('progress-fats').style.width = `${percentages.fats}%`;
    
    document.getElementById('progress-calories-text').textContent = 
        `${Math.round(totals.calories)} / ${userGoals.calories} kcal`;
    document.getElementById('progress-protein-text').textContent = 
        `${Math.round(totals.protein * 10) / 10} / ${userGoals.protein}g`;
    document.getElementById('progress-carbs-text').textContent = 
        `${Math.round(totals.carbs * 10) / 10} / ${userGoals.carbs}g`;
    document.getElementById('progress-fats-text').textContent = 
        `${Math.round(totals.fats * 10) / 10} / ${userGoals.fats}g`;
}

/**
 * Add food log to database
 */
async function addFoodLog(foodId, quantity, unitLabel, unitWeight, mealType) {
    try {
        const food = await db.foods.get(foodId);
        await db.logs.add({
            date: selectedDate || getTodayDate(),
            foodId,
            quantity,
            unitLabel,
            unitWeight,
            mealType,
            foodSyncId: food?.syncId ?? null
        });
        
        showToast('Food added successfully!', 'success');
        loadDayLogs();
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error adding food log:', error);
        showToast('Error adding food', 'error');
    }
}

/**
 * Delete food log
 */
async function deleteLog(logId) {
    try {
        const element = document.querySelector(`[data-log-id="${logId}"]`);
        if (element) {
            element.classList.add('deleting');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        await db.logs.delete(logId);
        loadDayLogs();
        showToast('Item removed', 'success');
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error deleting log:', error);
        showToast('Error removing item', 'error');
    }
}

// ===== SMART INSIGHTS ENGINE =====

/**
 * Generate contextual nutrition insights
 */
function generateInsights(totals, logCount) {
    const insights = [];
    const now = new Date();
    const hour = now.getHours();
    const viewingToday = isToday(selectedDate);
    
    // Time-based context (only relevant for today)
    const isBreakfastTime = viewingToday && hour >= 6 && hour < 10;
    const isLunchTime = viewingToday && hour >= 11 && hour < 14;
    const isDinnerTime = viewingToday && hour >= 18 && hour < 21;
    const isEndOfDay = viewingToday && hour >= 21;
    
    // Percentage of goals
    const caloriePercent = (totals.calories / userGoals.calories) * 100;
    const proteinPercent = (totals.protein / userGoals.protein) * 100;
    const carbsPercent = (totals.carbs / userGoals.carbs) * 100;
    const fatsPercent = (totals.fats / userGoals.fats) * 100;
    
    // No logs yet
    if (logCount === 0) {
        if (!viewingToday) {
            insights.push("📅 No meals were logged on this day. You can add entries to fill in your history.");
        } else if (isBreakfastTime) {
            insights.push("🌅 Good morning! Start your day with a protein-rich breakfast like eggs or poha.");
        } else if (isLunchTime) {
            insights.push("☀️ Lunchtime! Don't skip meals - log your thali to track progress.");
        } else {
            insights.push("📝 Start logging your meals to get personalized nutrition insights!");
        }
    }
    // Protein insights
    else if (proteinPercent < 30 && hour >= 12) {
        insights.push("🥚 You're low on protein today. Consider adding eggs, chicken, or dal to your next meal.");
    }
    else if (proteinPercent >= 100) {
        insights.push("💪 Great job! You've hit your protein goal for the day!");
    }
    // Calorie insights
    else if (caloriePercent > 90 && !isEndOfDay) {
        insights.push("⚠️ You're close to your calorie limit. Choose lighter options for remaining meals.");
    }
    else if (caloriePercent > 100) {
        insights.push("📊 You've exceeded your calorie goal. Consider a lighter dinner or some physical activity.");
    }
    else if (caloriePercent < 40 && isDinnerTime) {
        insights.push("🍽️ You're well under your calorie goal. Make sure to eat a fulfilling dinner!");
    }
    // Carbs insights
    else if (carbsPercent > 80 && fatsPercent < 50 && proteinPercent < 50) {
        insights.push("🍚 High carb intake detected. Balance it with some protein from dal or paneer.");
    }
    // Balanced meal
    else if (Math.abs(proteinPercent - carbsPercent) < 20 && Math.abs(carbsPercent - fatsPercent) < 20) {
        insights.push("✨ Your macros are well balanced today. Keep it up!");
    }
    // Fat insights
    else if (fatsPercent > 90 && caloriePercent < 60) {
        insights.push("🥜 High fat intake. While fats are essential, try to balance with more protein and carbs.");
    }
    // General positive
    else if (caloriePercent >= 70 && caloriePercent <= 90) {
        insights.push("👍 You're on track! Just a bit more to hit your daily targets.");
    }
    // Historical summary for past days
    else if (!viewingToday && logCount > 0) {
        if (caloriePercent >= 90 && caloriePercent <= 110) {
            insights.push(`✅ You hit your calorie goal on this day with ${Math.round(totals.calories)} kcal.`);
        } else if (caloriePercent < 90) {
            insights.push(`📊 You consumed ${Math.round(totals.calories)} kcal on this day (${Math.round(caloriePercent)}% of goal).`);
        } else {
            insights.push(`📊 You consumed ${Math.round(totals.calories)} kcal on this day, ${Math.round(caloriePercent - 100)}% over your goal.`);
        }
    }
    // Default
    else {
        const remaining = userGoals.calories - totals.calories;
        if (remaining > 0) {
            insights.push(`🎯 ${Math.round(remaining)} calories remaining for today. You've got this!`);
        }
    }
    
    // Display insight
    const insightText = document.getElementById('insight-text');
    insightText.textContent = insights[0] || "Keep tracking your meals for better insights!";
}

// ===== MODAL HANDLERS =====

/**
 * Open add food modal
 */
function openAddFoodModal(mealType) {
    currentMealType = mealType;
    document.getElementById('selected-meal-type').value = mealType;
    
    // Reset modal state
    selectedFood = null;
    document.getElementById('modal-food-search').value = '';
    document.getElementById('selected-food-details').classList.add('hidden');
    
    // Load foods
    renderModalFoodList();
    
    // Show modal
    document.getElementById('add-food-modal').classList.add('show');
}

/**
 * Render food list in modal
 */
async function renderModalFoodList(searchTerm = '') {
    const foodList = document.getElementById('modal-food-list');
    
    try {
        let foods = await db.foods.toArray();
        
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            foods = foods.filter(food => food.name.toLowerCase().includes(term));
            foods.sort((a, b) => a.name.localeCompare(b.name));
            foods = foods.slice(0, 80);
        } else {
            const userFoods = foods
                .filter((f) => f.source === 'user')
                .sort((a, b) => a.name.localeCompare(b.name));
            const catalog = foods
                .filter((f) => f.source !== 'user')
                .sort((a, b) => a.name.localeCompare(b.name));
            foods = [...userFoods, ...catalog.slice(0, 40)];
        }
        
        foodList.innerHTML = foods.map(food => `
            <div class="food-select-item ${selectedFood?.id === food.id ? 'selected' : ''}" 
                 data-food-id="${food.id}">
                <div class="font-medium text-sm">${food.name}</div>
                <div class="text-xs text-warm-gray">${food.calories} kcal/100g</div>
            </div>
        `).join('');
        
        // Add click handlers
        document.querySelectorAll('.food-select-item').forEach(item => {
            item.addEventListener('click', () => {
                selectFood(parseInt(item.dataset.foodId));
            });
        });
        
    } catch (error) {
        console.error('Error rendering modal food list:', error);
    }
}

/**
 * Select food in modal
 */
async function selectFood(foodId) {
    try {
        selectedFood = await db.foods.get(foodId);
        
        if (!selectedFood) return;
        
        // Update selection UI
        document.querySelectorAll('.food-select-item').forEach(item => {
            item.classList.toggle('selected', parseInt(item.dataset.foodId) === foodId);
        });
        
        // Show details section
        document.getElementById('selected-food-details').classList.remove('hidden');
        document.getElementById('selected-food-name').textContent = selectedFood.name;
        document.getElementById('selected-food-macros').textContent = 
            `Per 100g: ${selectedFood.calories} kcal · P: ${selectedFood.protein}g · C: ${selectedFood.carbs}g · F: ${selectedFood.fats}g`;
        
        // Populate unit options
        const unitSelect = document.getElementById('food-unit');
        unitSelect.innerHTML = `
            <option value="100" data-label="100g">100g</option>
            ${selectedFood.servingOptions.map(opt => 
                `<option value="${opt.weight}" data-label="${opt.label}">${opt.label}</option>`
            ).join('')}
        `;
        
        // Reset quantity
        document.getElementById('food-quantity').value = 1;
        
        // Calculate initial macros
        updateCalculatedMacros();
        
    } catch (error) {
        console.error('Error selecting food:', error);
    }
}

/**
 * Update calculated macros preview
 */
function updateCalculatedMacros() {
    if (!selectedFood) return;
    
    const quantity = parseFloat(document.getElementById('food-quantity').value) || 1;
    const unitSelect = document.getElementById('food-unit');
    const unitWeight = parseFloat(unitSelect.value) || 100;
    
    const macros = calculateMacros(selectedFood, quantity, unitWeight);
    
    document.getElementById('calc-calories').textContent = macros.calories;
    document.getElementById('calc-protein').textContent = `${macros.protein}g`;
    document.getElementById('calc-carbs').textContent = `${macros.carbs}g`;
    document.getElementById('calc-fats').textContent = `${macros.fats}g`;
}

/**
 * Confirm and add food
 */
function confirmAddFood() {
    if (!selectedFood) {
        showToast('Please select a food first', 'warning');
        return;
    }
    
    const quantity = parseFloat(document.getElementById('food-quantity').value) || 1;
    const unitSelect = document.getElementById('food-unit');
    const unitWeight = parseFloat(unitSelect.value) || 100;
    const unitLabel = unitSelect.options[unitSelect.selectedIndex].dataset.label;
    
    addFoodLog(selectedFood.id, quantity, unitLabel, unitWeight, currentMealType);
    closeModals();
}

/**
 * Open custom food modal
 */
function openCustomFoodModal() {
    document.getElementById('custom-food-form').reset();
    document.getElementById('serving-options-list').innerHTML = `
        <div class="serving-option flex gap-2">
            <input type="text" placeholder="e.g., 1 Bowl" class="serving-label flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
            <input type="number" placeholder="g" class="serving-weight w-20 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
        </div>
    `;
    document.getElementById('custom-food-modal').classList.add('show');
}

/**
 * Add serving option row
 */
function addServingOptionRow(container) {
    const row = document.createElement('div');
    row.className = 'serving-option flex gap-2';
    row.innerHTML = `
        <input type="text" placeholder="e.g., 1 Katori" class="serving-label flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
        <input type="number" placeholder="g" class="serving-weight w-20 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
        <button type="button" class="remove-serving-btn" onclick="this.parentElement.remove()">✕</button>
    `;
    container.appendChild(row);
}

/**
 * Save custom food
 */
async function saveCustomFood(formData) {
    try {
        const servingOptions = [];
        document.querySelectorAll('#serving-options-list .serving-option').forEach(row => {
            const label = row.querySelector('.serving-label').value.trim();
            const weight = parseFloat(row.querySelector('.serving-weight').value);
            if (label && weight) {
                servingOptions.push({ label, weight });
            }
        });
        
        const syncId = crypto.randomUUID();
        await db.foods.add({
            name: formData.name,
            protein: formData.protein,
            carbs: formData.carbs,
            fats: formData.fats,
            calories: formData.calories,
            category: formData.category,
            servingOptions: servingOptions.length ? servingOptions : [{ label: '100g', weight: 100 }],
            isDefault: false,
            source: 'user',
            externalKey: `user:${syncId}`,
            syncId
        });
        
        showToast('Custom dish created!', 'success');
        closeModals();
        const searchEl = document.getElementById('food-search');
        if (searchEl) searchEl.value = '';
        setFoodLibraryCategoryFilter(formData.category);
        await renderFoodLibrary('', formData.category);
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error saving custom food:', error);
        showToast('Error creating dish', 'error');
    }
}

/**
 * Open edit food modal
 */
async function openEditFoodModal(foodId) {
    try {
        const food = await db.foods.get(foodId);
        if (!food) return;
        
        document.getElementById('edit-food-id').value = food.id;
        document.getElementById('edit-name').value = food.name;
        document.getElementById('edit-category').value = food.category;
        document.getElementById('edit-calories').value = food.calories;
        document.getElementById('edit-protein').value = food.protein;
        document.getElementById('edit-carbs').value = food.carbs;
        document.getElementById('edit-fats').value = food.fats;
        
        // Populate serving options
        const container = document.getElementById('edit-serving-options-list');
        container.innerHTML = food.servingOptions.map((opt, i) => `
            <div class="serving-option flex gap-2">
                <input type="text" value="${opt.label}" class="serving-label flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
                <input type="number" value="${opt.weight}" class="serving-weight w-20 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-deep-green">
                ${i > 0 ? '<button type="button" class="remove-serving-btn" onclick="this.parentElement.remove()">✕</button>' : ''}
            </div>
        `).join('');
        
        document.getElementById('edit-food-modal').classList.add('show');
        
    } catch (error) {
        console.error('Error opening edit modal:', error);
    }
}

/**
 * Update existing food
 */
async function updateFood(foodId, formData) {
    try {
        const servingOptions = [];
        document.querySelectorAll('#edit-serving-options-list .serving-option').forEach(row => {
            const label = row.querySelector('.serving-label').value.trim();
            const weight = parseFloat(row.querySelector('.serving-weight').value);
            if (label && weight) {
                servingOptions.push({ label, weight });
            }
        });
        
        await db.foods.update(foodId, {
            name: formData.name,
            protein: formData.protein,
            carbs: formData.carbs,
            fats: formData.fats,
            calories: formData.calories,
            category: formData.category,
            servingOptions: servingOptions.length ? servingOptions : [{ label: '100g', weight: 100 }]
        });
        
        showToast('Dish updated!', 'success');
        closeModals();
        const searchEl = document.getElementById('food-search');
        if (searchEl) searchEl.value = '';
        setFoodLibraryCategoryFilter(formData.category);
        await renderFoodLibrary('', formData.category);
        loadDayLogs();
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error updating food:', error);
        showToast('Error updating dish', 'error');
    }
}

/**
 * Delete custom food
 */
async function deleteFood(foodId) {
    const food = await db.foods.get(foodId);

    if (food?.source && food.source !== 'user') {
        showToast('Catalog foods cannot be deleted', 'warning');
        return;
    }

    if (!confirm(`Are you sure you want to delete "${food?.name}"? This cannot be undone.`)) {
        return;
    }
    
    try {
        // Also delete related logs
        await db.logs.where('foodId').equals(foodId).delete();
        await db.foods.delete(foodId);
        
        showToast('Dish deleted', 'success');
        closeModals();
        await renderFoodLibraryFromUi();
        loadDayLogs();
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error deleting food:', error);
        showToast('Error deleting dish', 'error');
    }
}

/**
 * Close all modals
 */
function closeModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('show');
    });
    selectedFood = null;
}

// ===== WEIGHT TRACKING =====

/**
 * Open weight logging modal
 */
function openWeightModal() {
    document.getElementById('weight-date').value = getTodayDate();
    document.getElementById('weight-value').value = '';
    document.getElementById('weight-modal').classList.add('show');
}

/**
 * Save weight log
 */
async function saveWeight() {
    const date = document.getElementById('weight-date').value;
    const weight = parseFloat(document.getElementById('weight-value').value);
    
    if (!date || !weight || weight < 20 || weight > 300) {
        showToast('Please enter a valid weight', 'warning');
        return;
    }
    
    try {
        // Check if there's already a log for this date
        const existing = await db.weightLogs.where('date').equals(date).first();
        if (existing) {
            await db.weightLogs.update(existing.id, { weight });
        } else {
            await db.weightLogs.add({ date, weight });
        }
        
        showToast('Weight logged!', 'success');
        closeModals();
        loadWeightData();
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error saving weight:', error);
        showToast('Error saving weight', 'error');
    }
}

/**
 * Load and display weight data
 */
async function loadWeightData() {
    try {
        const logs = await db.weightLogs.orderBy('date').reverse().limit(30).toArray();
        logs.reverse(); // Oldest first for chart
        
        if (logs.length === 0) {
            document.getElementById('current-weight').textContent = '-- kg';
            document.getElementById('weight-change').innerHTML = '';
            return;
        }
        
        // Current weight
        const latest = logs[logs.length - 1];
        document.getElementById('current-weight').textContent = `${latest.weight} kg`;
        
        // Weight change
        if (logs.length >= 2) {
            const previous = logs[logs.length - 2];
            const change = latest.weight - previous.weight;
            const changeEl = document.getElementById('weight-change');
            
            if (change > 0) {
                changeEl.innerHTML = `<span class="weight-up">${change.toFixed(1)} kg from last</span>`;
            } else if (change < 0) {
                changeEl.innerHTML = `<span class="weight-down">${Math.abs(change).toFixed(1)} kg from last</span>`;
            } else {
                changeEl.innerHTML = `<span class="weight-same">No change</span>`;
            }
        }
        
        // Update chart
        updateWeightChart(logs);
        
    } catch (error) {
        console.error('Error loading weight data:', error);
    }
}

/**
 * Update weight trend chart
 */
function updateWeightChart(logs) {
    const ctx = document.getElementById('weight-chart').getContext('2d');
    
    if (charts.weight) {
        charts.weight.destroy();
    }
    
    charts.weight = new Chart(ctx, {
        type: 'line',
        data: {
            labels: logs.map(l => formatDate(l.date)),
            datasets: [{
                label: 'Weight (kg)',
                data: logs.map(l => l.weight),
                borderColor: '#2D5A27',
                backgroundColor: 'rgba(45, 90, 39, 0.1)',
                fill: true,
                tension: 0.3,
                pointBackgroundColor: '#2D5A27',
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    }
                },
                y: {
                    beginAtZero: false,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    }
                }
            }
        }
    });
}

// ===== ANALYSIS & CHARTS =====

/**
 * Load all analysis data
 */
async function loadAnalysisData() {
    await loadWeightData();
    await loadMacroPieChart();
    await loadCalorieTrendChart();
    await loadWeeklyAverages();
}

/**
 * Load macro pie chart for today
 */
async function loadMacroPieChart() {
    const today = getTodayDate();
    
    try {
        const logs = await db.logs.where('date').equals(today).toArray();
        const foods = await db.foods.toArray();
        const { foodMap, foodBySync } = buildFoodLookups(foods);

        let totals = { protein: 0, carbs: 0, fats: 0 };

        logs.forEach(log => {
            const food = resolveFoodForLog(log, foodMap, foodBySync);
            if (food) {
                const macros = calculateMacros(food, log.quantity, log.unitWeight);
                totals.protein += macros.protein;
                totals.carbs += macros.carbs;
                totals.fats += macros.fats;
            }
        });
        
        const ctx = document.getElementById('macro-pie-chart').getContext('2d');
        
        if (charts.macroPie) {
            charts.macroPie.destroy();
        }
        
        const hasData = totals.protein + totals.carbs + totals.fats > 0;
        
        charts.macroPie = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Protein', 'Carbs', 'Fats'],
                datasets: [{
                    data: hasData ? [totals.protein, totals.carbs, totals.fats] : [1, 1, 1],
                    backgroundColor: hasData 
                        ? ['#F87171', '#60A5FA', '#4ADE80']
                        : ['#E5E7EB', '#E5E7EB', '#E5E7EB'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        enabled: hasData,
                        callbacks: {
                            label: function(context) {
                                const total = totals.protein + totals.carbs + totals.fats;
                                const percent = Math.round((context.raw / total) * 100);
                                return `${context.label}: ${context.raw.toFixed(1)}g (${percent}%)`;
                            }
                        }
                    }
                }
            }
        });
        
    } catch (error) {
        console.error('Error loading macro pie chart:', error);
    }
}

/**
 * Load 7-day calorie trend chart
 */
async function loadCalorieTrendChart() {
    try {
        const foods = await db.foods.toArray();
        const { foodMap, foodBySync } = buildFoodLookups(foods);

        // Get last 7 days
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            days.push(date.toISOString().split('T')[0]);
        }

        // Get calories for each day
        const calorieData = await Promise.all(days.map(async (date) => {
            const logs = await db.logs.where('date').equals(date).toArray();
            let total = 0;
            logs.forEach(log => {
                const food = resolveFoodForLog(log, foodMap, foodBySync);
                if (food) {
                    const macros = calculateMacros(food, log.quantity, log.unitWeight);
                    total += macros.calories;
                }
            });
            return total;
        }));
        
        const ctx = document.getElementById('calorie-trend-chart').getContext('2d');
        
        if (charts.calorieTrend) {
            charts.calorieTrend.destroy();
        }
        
        charts.calorieTrend = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: days.map(d => formatDate(d)),
                datasets: [{
                    label: 'Calories',
                    data: calorieData,
                    backgroundColor: calorieData.map(cal => 
                        cal > userGoals.calories ? '#F87171' : '#FF9933'
                    ),
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    annotation: {
                        annotations: {
                            line1: {
                                type: 'line',
                                yMin: userGoals.calories,
                                yMax: userGoals.calories,
                                borderColor: '#2D5A27',
                                borderWidth: 2,
                                borderDash: [5, 5]
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.05)'
                        }
                    }
                }
            }
        });
        
    } catch (error) {
        console.error('Error loading calorie trend chart:', error);
    }
}

/**
 * Load weekly averages
 */
async function loadWeeklyAverages() {
    try {
        const foods = await db.foods.toArray();
        const { foodMap, foodBySync } = buildFoodLookups(foods);

        // Get last 7 days of data
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            days.push(date.toISOString().split('T')[0]);
        }

        let totalDays = 0;
        let sums = { calories: 0, protein: 0, carbs: 0, fats: 0 };

        for (const date of days) {
            const logs = await db.logs.where('date').equals(date).toArray();
            if (logs.length > 0) {
                totalDays++;
                logs.forEach(log => {
                    const food = resolveFoodForLog(log, foodMap, foodBySync);
                    if (food) {
                        const macros = calculateMacros(food, log.quantity, log.unitWeight);
                        sums.calories += macros.calories;
                        sums.protein += macros.protein;
                        sums.carbs += macros.carbs;
                        sums.fats += macros.fats;
                    }
                });
            }
        }
        
        if (totalDays > 0) {
            document.getElementById('avg-calories').textContent = Math.round(sums.calories / totalDays);
            document.getElementById('avg-protein').textContent = `${Math.round(sums.protein / totalDays)}g`;
            document.getElementById('avg-carbs').textContent = `${Math.round(sums.carbs / totalDays)}g`;
            document.getElementById('avg-fats').textContent = `${Math.round(sums.fats / totalDays)}g`;
        } else {
            document.getElementById('avg-calories').textContent = '--';
            document.getElementById('avg-protein').textContent = '--';
            document.getElementById('avg-carbs').textContent = '--';
            document.getElementById('avg-fats').textContent = '--';
        }
        
    } catch (error) {
        console.error('Error loading weekly averages:', error);
    }
}

// ===== SETTINGS & DATA MANAGEMENT =====

/**
 * Save user goals
 */
async function saveGoals() {
    try {
        userGoals = {
            calories: parseInt(document.getElementById('goal-calories').value) || DEFAULT_GOALS.calories,
            protein: parseInt(document.getElementById('goal-protein').value) || DEFAULT_GOALS.protein,
            carbs: parseInt(document.getElementById('goal-carbs').value) || DEFAULT_GOALS.carbs,
            fats: parseInt(document.getElementById('goal-fats').value) || DEFAULT_GOALS.fats
        };
        
        const prev = (await db.userSettings.get(1)) || {};
        await db.userSettings.put({
            ...prev,
            id: 1,
            dailyGoals: userGoals
        });

        showToast('Goals saved!', 'success');
        loadDayLogs();
        triggerAutoSave(); // Auto-save to file
        
    } catch (error) {
        console.error('Error saving goals:', error);
        showToast('Error saving goals', 'error');
    }
}

/**
 * Export all data to JSON
 */
async function exportData() {
    try {
        const data = {
            version: 1,
            exportDate: new Date().toISOString(),
            foods: await db.foods.toArray(),
            logs: await db.logs.toArray(),
            weightLogs: await db.weightLogs.toArray(),
            userSettings: await db.userSettings.toArray()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `macro-tracker-backup-${getTodayDate()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast('Data exported successfully!', 'success');
        
    } catch (error) {
        console.error('Error exporting data:', error);
        showToast('Error exporting data', 'error');
    }
}

/**
 * Import data from JSON file
 */
async function importData(file) {
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.version || !Array.isArray(data.foods) || !Array.isArray(data.logs)) {
            throw new Error('Invalid backup file format');
        }

        const replace = confirm(
            'Replace ALL data with this backup?\n\n' +
                'OK = full replace (everything).\n' +
                'Cancel = merge only custom / user foods from the file (keeps your logs and catalog).'
        );

        if (!replace) {
            for (const f of data.foods) {
                const isUser = f.source === 'user' || f.isDefault === false;
                if (!isUser) continue;
                const norm = normalizeImportedFoodRow(f);
                const existing = await db.foods
                    .where('syncId')
                    .equals(norm.syncId)
                    .filter((x) => x.source === 'user')
                    .first();
                const { id: _drop, ...rest } = norm;
                if (existing) await db.foods.update(existing.id, { ...rest, id: existing.id });
                else await db.foods.add(rest);
            }
            showToast('Merged custom foods from backup', 'success');
            loadDayLogs();
            renderFoodLibraryFromUi();
            scheduleCloudSync();
            return;
        }

        await importDataToDb(data);

        const settings = await db.userSettings.get(1);
        if (settings) {
            userGoals = settings.dailyGoals;
            document.getElementById('goal-calories').value = userGoals.calories;
            document.getElementById('goal-protein').value = userGoals.protein;
            document.getElementById('goal-carbs').value = userGoals.carbs;
            document.getElementById('goal-fats').value = userGoals.fats;
        }

        showToast('Data imported successfully!', 'success');
        loadDayLogs();
        renderFoodLibraryFromUi();
        scheduleCloudSync();
    } catch (error) {
        console.error('Error importing data:', error);
        showToast('Error importing data. Check file format.', 'error');
    }
}

/**
 * Reset all data (keeps custom user foods; clears logs, weights, goals; rebuilds catalog)
 */
async function resetAllData() {
    try {
        const userFoods = await db.foods.filter((f) => f.source === 'user').toArray();

        await db.foods.clear();
        await db.logs.clear();
        await db.weightLogs.clear();
        await db.userSettings.clear();

        const starterRows = STARTER_PACK_FOODS.map(mapStarterFoodForSeed);
        await db.foods.bulkAdd(starterRows);
        await mergeIndbCatalogFromNetwork(true);

        for (const u of userFoods) {
            const { id: _id, ...rest } = u;
            await db.foods.add(rest);
        }

        await db.userSettings.put({
            id: 1,
            dailyGoals: DEFAULT_GOALS
        });

        userGoals = { ...DEFAULT_GOALS };
        document.getElementById('goal-calories').value = DEFAULT_GOALS.calories;
        document.getElementById('goal-protein').value = DEFAULT_GOALS.protein;
        document.getElementById('goal-carbs').value = DEFAULT_GOALS.carbs;
        document.getElementById('goal-fats').value = DEFAULT_GOALS.fats;

        showToast('Logs cleared; custom dishes kept; catalog rebuilt', 'success');
        closeModals();
        loadDayLogs();
        renderFoodLibraryFromUi();
        triggerAutoSave();
    } catch (error) {
        console.error('Error resetting data:', error);
        showToast('Error resetting data', 'error');
    }
}

// ===== AUTH GATE & SUPABASE UI =====

function showMainAppUI() {
    document.getElementById('auth-gate')?.classList.add('hidden');
    document.getElementById('app')?.classList.remove('hidden');
}

function showAuthGateOnly() {
    document.getElementById('auth-gate')?.classList.remove('hidden');
    document.getElementById('app')?.classList.add('hidden');
}

function updateSupabaseConfigHint() {
    const cfg = window.MACRO_TRACKER_CONFIG;
    const ok = cfg?.supabaseUrl && cfg?.supabaseAnonKey;
    document.getElementById('supabase-config-hint')?.classList.toggle('hidden', !!ok);
    document.getElementById('auth-gate-form')?.classList.toggle('hidden', !ok);
    document.getElementById('auth-gate-config-missing')?.classList.toggle('hidden', !!ok);
}

function updateAuthUI(session) {
    const emailEl = document.getElementById('supabase-user-email');
    if (emailEl) emailEl.textContent = session?.user?.email || '—';
}

/** 'signin' | 'signup' */
let authGateMode = 'signin';

function setAuthGateStatus(text, kind = 'clear') {
    const el = document.getElementById('auth-gate-status');
    if (!el) return;
    el.textContent = text || '';
    el.className =
        'text-sm mb-3 min-h-[1.25rem] rounded-lg px-2 py-1';
    if (kind === 'error') {
        el.classList.add('bg-red-500/25', 'text-red-50');
    } else if (kind === 'success') {
        el.classList.add('bg-white/15', 'text-white');
    } else if (text) {
        el.classList.add('text-green-100');
    }
}

function setAuthGateMode(mode) {
    if (mode !== 'signin' && mode !== 'signup') return;
    authGateMode = mode;

    const signinRadio = document.getElementById('auth-mode-signin');
    const signupRadio = document.getElementById('auth-mode-signup');
    if (signinRadio && signupRadio) {
        if (mode === 'signin') signinRadio.checked = true;
        else signupRadio.checked = true;
    }

    const confirmWrap = document.getElementById('auth-gate-confirm-wrap');
    const confirmInput = document.getElementById('auth-gate-password-confirm');
    const primaryBtn = document.getElementById('auth-gate-primary-btn');
    const pwd = document.getElementById('auth-gate-password');
    const hint = document.getElementById('auth-gate-hint');

    if (mode === 'signin') {
        confirmWrap?.classList.add('hidden');
        confirmWrap?.setAttribute('aria-hidden', 'true');
        confirmInput?.removeAttribute('required');
        if (primaryBtn) primaryBtn.textContent = 'Sign in';
        if (pwd) {
            pwd.autocomplete = 'current-password';
            pwd.setAttribute('minlength', '6');
        }
        if (hint) {
            hint.innerHTML =
                'Use your email and password. Need an account? Choose <strong class="text-white">Create account</strong> at the top.';
        }
    } else {
        confirmWrap?.classList.remove('hidden');
        confirmWrap?.setAttribute('aria-hidden', 'false');
        confirmInput?.removeAttribute('required');
        if (primaryBtn) primaryBtn.textContent = 'Create account';
        if (pwd) {
            pwd.autocomplete = 'new-password';
            pwd.setAttribute('minlength', '6');
        }
        if (hint) {
            hint.textContent =
                'After submitting, you may be signed in immediately, or asked to confirm your email first (depends on your Supabase project settings).';
        }
    }
    setAuthGateStatus('', 'clear');
}

function withNetworkTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(message)), ms);
        })
    ]);
}

async function authGateSubmit() {
    const mode =
        document.querySelector('input[name="authGateMode"]:checked')?.value === 'signup' ? 'signup' : 'signin';
    authGateMode = mode;

    const email = document.getElementById('auth-gate-email')?.value.trim();
    const password = document.getElementById('auth-gate-password')?.value ?? '';
    const client = getSupabase();
    const btn = document.getElementById('auth-gate-primary-btn');

    setAuthGateStatus('', 'clear');

    if (!client) {
        setAuthGateStatus('Supabase is not configured. Add URL and anon key to config.js.', 'error');
        showToast('Configure Supabase in config.js', 'warning');
        return;
    }
    if (!email) {
        setAuthGateStatus('Please enter your email.', 'error');
        document.getElementById('auth-gate-email')?.focus();
        return;
    }
    if (!password || password.length < 6) {
        setAuthGateStatus('Password must be at least 6 characters.', 'error');
        document.getElementById('auth-gate-password')?.focus();
        return;
    }

    if (mode === 'signup') {
        const confirm = document.getElementById('auth-gate-password-confirm')?.value ?? '';
        if (!confirm) {
            setAuthGateStatus('Please confirm your password.', 'error');
            document.getElementById('auth-gate-password-confirm')?.focus();
            return;
        }
        if (password !== confirm) {
            setAuthGateStatus('Passwords do not match.', 'error');
            document.getElementById('auth-gate-password-confirm')?.focus();
            return;
        }
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
    }

    const authTimeoutMs = 45000;
    const timeoutMsg =
        'Request timed out. Check your connection, Supabase project status, and that this site URL is allowed in Supabase Auth → URL configuration.';

    try {
        if (mode === 'signup') {
            const redirect = window.location.origin + window.location.pathname;
            const { data, error } = await withNetworkTimeout(
                client.auth.signUp({
                    email,
                    password,
                    options: { emailRedirectTo: redirect }
                }),
                authTimeoutMs,
                timeoutMsg
            );
            if (error) {
                setAuthGateStatus(error.message, 'error');
                showToast(error.message, 'error');
                return;
            }
            if (data.session) {
                setAuthGateStatus('Account created. Loading your data…', 'success');
                showToast('Signed in', 'success');
                await ensureAppBooted(data.session);
            } else {
                setAuthGateStatus(
                    'Account created. Check your email to confirm, then use Sign in below.',
                    'success'
                );
                showToast('Confirm your email if required, then sign in', 'success');
                setAuthGateMode('signin');
            }
            return;
        }

        const { data: signInData, error } = await withNetworkTimeout(
            client.auth.signInWithPassword({ email, password }),
            authTimeoutMs,
            timeoutMsg
        );
        if (error) {
            setAuthGateStatus(error.message, 'error');
            showToast(error.message, 'error');
            return;
        }
        const session = signInData?.session;
        if (session?.user) {
            setAuthGateStatus('Loading your data…', 'success');
            await ensureAppBooted(session);
        } else {
            setAuthGateStatus('Signed in but no session returned. Try again or confirm your email.', 'error');
            showToast('No session after sign-in', 'warning');
        }
    } catch (err) {
        console.error('authGateSubmit', err);
        const msg = err?.message || String(err);
        setAuthGateStatus(msg || 'Something went wrong. Check the browser console.', 'error');
        showToast('Sign-in failed', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            const checkedMode =
                document.querySelector('input[name="authGateMode"]:checked')?.value === 'signup'
                    ? 'signup'
                    : 'signin';
            btn.textContent = checkedMode === 'signup' ? 'Create account' : 'Sign in';
        }
    }
}

async function handleSignedOut() {
    lastBootedUserId = null;
    destroyCharts();
    selectedFood = null;
    closeModals();
    await closeUserDatabase();
    showAuthGateOnly();
}

async function refreshMainAppData() {
    selectedDate = getTodayDate();
    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.value = selectedDate;
        datePicker.max = selectedDate;
    }
    const headerDate = document.getElementById('header-date');
    if (headerDate) headerDate.textContent = 'Today';
    await loadDayLogs();
    updateDateDisplay();
    switchTab('today');
    updateStorageStatusUI();
}

async function ensureAppBooted(session) {
    const uid = session.user.id;
    if (lastBootedUserId === uid && db && mainAppListenersBound) {
        updateAuthUI(session);
        return;
    }
    if (!appBootPromise) {
        appBootPromise = (async () => {
            await openDatabaseForUser(uid);
            await initializeDatabase();
            await pullFromSupabase(false);
            scheduleCloudSync();
            showMainAppUI();
            if (!mainAppListenersBound) {
                bindMainAppListeners();
                mainAppListenersBound = true;
            }
            await refreshMainAppData();
            lastBootedUserId = uid;
            const { data: { session: s } } = await getSupabase().auth.getSession();
            updateAuthUI(s);
        })().finally(() => {
            appBootPromise = null;
        });
    }
    return appBootPromise;
}

async function signOutSupabase() {
    updateSyncStatusUI('', false);
    await getSupabase()?.auth.signOut();
}

async function syncNowToCloud() {
    if (!db) {
        showToast('Sign in first', 'warning');
        return;
    }
    const client = getSupabase();
    if (!client) {
        showToast('Configure config.js first', 'warning');
        return;
    }
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
        showToast('Sign in first', 'warning');
        return;
    }
    await pushToSupabase();
    showToast('Saved to cloud', 'success');
}

async function forcePullFromCloud() {
    if (!db) {
        showToast('Sign in first', 'warning');
        return;
    }
    const client = getSupabase();
    if (!client) {
        showToast('Configure config.js first', 'warning');
        return;
    }
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
        showToast('Sign in first', 'warning');
        return;
    }
    if (!confirm('Replace local logs and cloud-synced data with the server copy?')) return;
    await pullFromSupabase(true);
}

// ===== EVENT LISTENERS =====

function bindMainAppListeners() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('prev-day-btn')?.addEventListener('click', goToPreviousDay);
    document.getElementById('next-day-btn')?.addEventListener('click', goToNextDay);
    document.getElementById('go-to-today-btn')?.addEventListener('click', goToToday);
    document.getElementById('date-picker')?.addEventListener('change', (e) => setDate(e.target.value));

    document.querySelectorAll('.add-food-btn').forEach((btn) => {
        btn.addEventListener('click', () => openAddFoodModal(btn.dataset.meal));
    });

    document.querySelectorAll('.close-modal').forEach((btn) => {
        btn.addEventListener('click', closeModals);
    });

    document.querySelectorAll('.modal').forEach((modal) => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModals();
        });
    });

    const modalSearch = document.getElementById('modal-food-search');
    modalSearch.addEventListener('input', debounce((e) => {
        renderModalFoodList(e.target.value);
    }, 300));

    document.getElementById('food-quantity').addEventListener('input', updateCalculatedMacros);
    document.getElementById('food-unit').addEventListener('change', updateCalculatedMacros);

    document.getElementById('confirm-add-food').addEventListener('click', confirmAddFood);

    const librarySearch = document.getElementById('food-search');
    librarySearch.addEventListener('input', debounce((e) => {
        const activeCategory = document.querySelector('.category-btn.active')?.dataset.category || 'all';
        renderFoodLibrary(e.target.value, activeCategory);
    }, 300));

    document.querySelectorAll('.category-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.category-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            renderFoodLibrary(librarySearch.value, btn.dataset.category);
        });
    });

    document.getElementById('add-custom-food-btn').addEventListener('click', openCustomFoodModal);

    document.getElementById('add-serving-option').addEventListener('click', () => {
        addServingOptionRow(document.getElementById('serving-options-list'));
    });

    document.getElementById('custom-food-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveCustomFood({
            name: document.getElementById('custom-name').value.trim(),
            category: document.getElementById('custom-category').value,
            calories: parseFloat(document.getElementById('custom-calories').value),
            protein: parseFloat(document.getElementById('custom-protein').value),
            carbs: parseFloat(document.getElementById('custom-carbs').value),
            fats: parseFloat(document.getElementById('custom-fats').value)
        });
    });

    document.getElementById('edit-add-serving-option').addEventListener('click', () => {
        addServingOptionRow(document.getElementById('edit-serving-options-list'));
    });

    document.getElementById('edit-food-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const foodId = parseInt(document.getElementById('edit-food-id').value, 10);
        updateFood(foodId, {
            name: document.getElementById('edit-name').value.trim(),
            category: document.getElementById('edit-category').value,
            calories: parseFloat(document.getElementById('edit-calories').value),
            protein: parseFloat(document.getElementById('edit-protein').value),
            carbs: parseFloat(document.getElementById('edit-carbs').value),
            fats: parseFloat(document.getElementById('edit-fats').value)
        });
    });

    document.getElementById('delete-food-btn').addEventListener('click', () => {
        const foodId = parseInt(document.getElementById('edit-food-id').value, 10);
        deleteFood(foodId);
    });

    document.getElementById('log-weight-btn').addEventListener('click', openWeightModal);
    document.getElementById('save-weight-btn').addEventListener('click', saveWeight);

    document.getElementById('save-goals-btn').addEventListener('click', saveGoals);
    document.getElementById('export-data-btn').addEventListener('click', exportData);

    document.getElementById('import-data-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            importData(file);
            e.target.value = '';
        }
    });

    document.getElementById('set-storage-file-btn').addEventListener('click', setupFileStorage);
    document.getElementById('disconnect-storage-btn').addEventListener('click', disconnectFileStorage);

    document.getElementById('reset-data-btn').addEventListener('click', () => {
        document.getElementById('confirm-reset-modal').classList.add('show');
    });

    document.getElementById('confirm-reset-btn').addEventListener('click', resetAllData);

    document.getElementById('supabase-sign-out-btn')?.addEventListener('click', signOutSupabase);
    document.getElementById('supabase-sync-now-btn')?.addEventListener('click', syncNowToCloud);
    document.getElementById('supabase-pull-btn')?.addEventListener('click', forcePullFromCloud);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden' || !db) return;
        const client = getSupabase();
        if (!client) return;
        client.auth.getSession().then(({ data: { session } }) => {
            if (session) pushToSupabase();
        });
    });

    window.addEventListener('pagehide', () => {
        if (!db) return;
        const client = getSupabase();
        if (!client) return;
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
            syncDebounceTimer = null;
        }
        client.auth.getSession().then(({ data: { session } }) => {
            if (session) pushToSupabase();
        });
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    updateSupabaseConfigHint();

    document.querySelectorAll('.auth-gate-mode-input').forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) setAuthGateMode(input.value);
        });
    });
    document.getElementById('auth-gate-credentials-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        authGateSubmit();
    });
    setAuthGateMode('signin');

    const sb = getSupabase();
    if (!sb) {
        showAuthGateOnly();
        console.warn('Macro Tracker: configure Supabase in config.js');
        return;
    }

    sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'TOKEN_REFRESHED') return;
        if (session?.user) await ensureAppBooted(session);
        else await handleSignedOut();
        updateAuthUI(session);
    });

    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) await ensureAppBooted(session);
    else await handleSignedOut();
    updateAuthUI(session);

    console.log('Macro Tracker initialized successfully!');
});

// Make deleteLog globally accessible for inline onclick
window.deleteLog = deleteLog;

