// Fake mínimo do driver do MongoDB — só o que o server.js usa.
let seq = 0;
class ObjectId { constructor(h){ this.h = h || ('oid' + (++seq).toString().padStart(8,'0')); } toString(){ return this.h; } static isValid(x){ return typeof x === 'string' && x.startsWith('oid'); } equals(o){ return String(o)===this.h; } }
const get = (d, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), d);
const eq = (a, b) => (a instanceof Date && b instanceof Date) ? a.getTime() === b.getTime() : String(a) === String(b) && (typeof a === typeof b || a instanceof ObjectId || b instanceof ObjectId);
function matchCond(v, c) {
  if (c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof ObjectId) && Object.keys(c).some(k => k.startsWith('$'))) {
    return Object.entries(c).every(([op, x]) => {
      if (op === '$lte') return v != null && v <= x;
      if (op === '$lt') return v != null && v < x;
      if (op === '$gte') return v != null && v >= x;
      if (op === '$ne') return !(v !== undefined && eq(v, x));
      if (op === '$in') return x.some(y => v !== undefined && eq(v, y));
      if (op === '$nin') return !x.some(y => v !== undefined && eq(v, y));
      if (op === '$type') return x === 'string' ? typeof v === 'string' : true;
      throw new Error('op ' + op);
    });
  }
  return v !== undefined && eq(v, c);
}
const match = (d, f) => Object.entries(f || {}).every(([k, c]) => matchCond(get(d, k), c));
function applyUpd(d, u) {
  if (u.$set) Object.assign(d, JSON.parse(JSON.stringify(u.$set), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) ? new Date(v) : v));
  if (u.$unset) Object.keys(u.$unset).forEach(k => delete d[k]);
  if (u.$inc) Object.entries(u.$inc).forEach(([k, n]) => d[k] = (d[k] || 0) + n);
}
function sorter(sort) { return (a, b) => { for (const [k, dir] of Object.entries(sort || {})) { const x = get(a, k), y = get(b, k); if (x < y) return -dir; if (x > y) return dir; } return 0; }; }
class Col {
  constructor(n){ this.n = n; this.docs = []; }
  async createIndex(){ return 'ok'; }
  async insertOne(doc){ if (doc.idempotencyKey && this.n === 'envio_fila' && this.docs.some(d => d.idempotencyKey === doc.idempotencyKey)) { const e = new Error('dup'); e.code = 11000; throw e; } const d = { ...doc, _id: doc._id || new ObjectId() }; this.docs.push(d); return { insertedId: d._id }; }
  async findOne(f){ const d = this.docs.find(x => match(x, f)); return d ? { ...d } : null; }
  find(f){ let arr = this.docs.filter(x => match(x, f)); const api = { sort(s){ arr = arr.slice().sort(sorter(s)); return api; }, limit(n){ arr = arr.slice(0, n); return api; }, async toArray(){ return arr.map(x => ({ ...x })); } }; return api; }
  async findOneAndUpdate(f, u, o){ const c = this.docs.filter(x => match(x, f)).sort(sorter(o && o.sort)); if (!c.length) return null; applyUpd(c[0], u); return { ...c[0] }; }
  async updateOne(f, u){ const d = this.docs.find(x => match(x, f)); if (d) applyUpd(d, u); return { modifiedCount: d ? 1 : 0 }; }
  async updateMany(f, u){ const ds = this.docs.filter(x => match(x, f)); ds.forEach(d => applyUpd(d, u)); return { modifiedCount: ds.length }; }
  async replaceOne(f, doc, o){ const i = this.docs.findIndex(x => match(x, f)); if (i >= 0) this.docs[i] = { ...doc }; else this.docs.push({ ...doc }); return {}; }
  async deleteOne(f){ const i = this.docs.findIndex(x => match(x, f)); if (i >= 0) this.docs.splice(i, 1); return {}; }
  async deleteMany(f){ const n = this.docs.length; this.docs = this.docs.filter(x => !match(x, f)); return { deletedCount: n - this.docs.length }; }
  async countDocuments(f){ return this.docs.filter(x => match(x, f)).length; }
  aggregate(p){ const self = this; return { async toArray(){ let arr = self.docs.slice(); for (const st of p) { if (st.$match) arr = arr.filter(x => match(x, st.$match)); else if (st.$group) { const g = {}; arr.forEach(x => { const key = get(x, st.$group._id.slice(1)); g[key] = g[key] || { _id: key, n: 0 }; g[key].n++; }); arr = Object.values(g); } } return arr; } }; }
}
const dbs = {};
class MongoClient { constructor(){} async connect(){} db(n){ dbs[n] = dbs[n] || { cols: {}, collection(c){ this.cols[c] = this.cols[c] || new Col(c); return this.cols[c]; } }; return dbs[n]; } async close(){} }
module.exports = { MongoClient, ObjectId, _dbs: dbs };
