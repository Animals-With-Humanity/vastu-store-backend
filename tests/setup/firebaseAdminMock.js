/**
 * A lightweight, hand-rolled in-memory stand-in for firebase-admin/Firestore.
 *
 * IMPORTANT: this is NOT a general-purpose Firestore emulator. It only
 * implements the exact call patterns index.js actually uses.
 */

let store;
let faults;

function reset() {
  store = {
    products: {},
    coupons: {},
    orders: {},
    config: {},
    failed_payments: {},
  };
  faults = {};
}
reset();

/**
 * Deep clone that PRESERVES functions.
 * JSON.parse(JSON.stringify()) strips functions (like Firestore Timestamp.toMillis),
 * which breaks expiry-related tests.
 */
function clone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(clone);
  }

  const copy = {};
  for (const key of Object.keys(obj)) {
    copy[key] = clone(obj[key]);
  }
  return copy;
}

function maybeThrow(collection, method) {
  const key = `${collection}:${method}`;
  if (faults[key]) {
    const err = faults[key];
    delete faults[key];
    throw err;
  }
}

function applyFieldUpdate(target, key, value) {
  if (value && value.__isIncrement) {
    target[key] = (target[key] || 0) + value.amount;
    return;
  }

  if (value && value.__isServerTimestamp) {
    const now = Date.now();
    target[key] = {
      toMillis: () => now,
      toDate: () => new Date(now),
    };
    return;
  }

  if (key.includes(".")) {
    const parts = key.split(".");
    let obj = target;

    for (let i = 0; i < parts.length - 1; i++) {
      obj[parts[i]] = obj[parts[i]] || {};
      obj = obj[parts[i]];
    }

    obj[parts[parts.length - 1]] = value;
    return;
  }

  target[key] = value;
}

function applyUpdateSync(collectionName, id, data) {
  maybeThrow(collectionName, "update");

  const existing = store[collectionName][id];

  if (!existing) {
    throw new Error(`No document to update: ${collectionName}/${id}`);
  }

  for (const key of Object.keys(data)) {
    applyFieldUpdate(existing, key, data[key]);
  }
}

function makeDocRef(collectionName, id) {
  return {
    id,
    __collection: collectionName,

    get: jest.fn(async () => {
      maybeThrow(collectionName, "get");

      const data = store[collectionName][id];

      return {
        exists: !!data,
        id,
        data: () => clone(data),
      };
    }),

    set: jest.fn(async (data) => {
      maybeThrow(collectionName, "set");
      store[collectionName][id] = clone(data);
      return {};
    }),

    update: jest.fn(async (data) => {
      applyUpdateSync(collectionName, id, data);
      return {};
    }),
  };
}

function makeCollectionRef(name) {
  return {
    doc: (id) => makeDocRef(name, id),

    add: jest.fn(async (data) => {
      maybeThrow(name, "add");

      const id = "auto_" + Math.random().toString(36).slice(2, 12);

      store[name][id] = clone(data);

      return { id };
    }),

    where(field, op, value) {
      const filters = [{ field, op, value }];

      const builder = {
        where(f2, o2, v2) {
          filters.push({
            field: f2,
            op: o2,
            value: v2,
          });
          return builder;
        },

        limit(n) {
          return {
            get: jest.fn(async () => {
              maybeThrow(name, "query");

              const matches = Object.entries(store[name])
                .filter(([, data]) =>
                  filters.every((f) =>
                    f.op === "=="
                      ? data[f.field] === f.value
                      : true
                  )
                )
                .slice(0, n);

              return {
                empty: matches.length === 0,
                docs: matches.map(([id, data]) => ({
                  id,
                  data: () => clone(data),
                })),
              };
            }),
          };
        },
      };

      return builder;
    },
  };
}

const FieldValue = {
  increment: (amount) => ({
    __isIncrement: true,
    amount,
  }),

  serverTimestamp: () => ({
    __isServerTimestamp: true,
  }),
};

const db = {
  collection: (name) => makeCollectionRef(name),

  runTransaction: jest.fn(async (updateFunction) => {
    const transaction = {
      get: async (ref) => ref.get(),

      update: (ref, data) =>
        applyUpdateSync(ref.__collection, ref.id, data),
    };

    return updateFunction(transaction);
  }),
};

const firestoreFn = jest.fn(() => db);
firestoreFn.FieldValue = FieldValue;

module.exports = {
  // Firebase Admin API
  initializeApp: jest.fn(),

  credential: {
    cert: jest.fn(() => ({})),
  },

  firestore: firestoreFn,

  // Test helpers
  __reset: reset,

  __setProduct: (id, data) => {
    store.products[id] = clone(data);
  },

  __setCoupon: (id, data) => {
    store.coupons[id] = clone(data);
  },

  __setOrder: (id, data) => {
    store.orders[id] = clone(data);
  },

  __setConfig: (data) => {
    store.config.settings = clone(data);
  },

  __getOrder: (id) => clone(store.orders[id]),

  __getProduct: (id) => clone(store.products[id]),

  __getCoupon: (id) => clone(store.coupons[id]),

  __getFailedPayments: () => clone(Object.values(store.failed_payments)),

  __injectFailure: (
    collection,
    method,
    error = new Error("Simulated Firestore failure")
  ) => {
    faults[`${collection}:${method}`] = error;
  },
};