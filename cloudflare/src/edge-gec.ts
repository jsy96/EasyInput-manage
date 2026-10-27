// Edge read-aloud client interoperability, adapted from edge-tts 7.3.1 (LGPL-3.0).
// Upstream: https://github.com/rany2/edge-tts/blob/7.3.1/src/edge_tts/drm.py
const initial = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]
const state0 = [4255104674, 2435071207, 3192492180, 3442351626, 1811967817, 79508907, 4272990180, 66059218]
const schedule = [3945054110, 358115615, 2696978146, 217723578, 2787307148, 3520959633, 3235718560, 4192668342, 4039316851, 1884868174, 1904797190, 15051571, 3529027680, 1920361828]
const rounds = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]
const coefficients = [[3895366065, 3005677776], [1155409094, 2296378653], [1005282748, 693190712], [3365689651, 3005795295], [2367603217, 3557143765], [827258325, 652566332], [3911487921, 1618477510], [4037392853, 2192753147], [101076211, 4199654362], [3665427040, 545047652], [3201434976, 1010595059], [2314848760, 3536931681], [905590982, 3137643201], [3410617286, 3311559015]]
const r = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
const s0 = (x: number): number => (r(x, 7) ^ r(x, 18) ^ (x >>> 3)) >>> 0
const s1 = (x: number): number => (r(x, 17) ^ r(x, 19) ^ (x >>> 10)) >>> 0
const rol = (x: number): number => ((x << 16) | (x >>> 16)) >>> 0
const mul = (a: number, b: number): number => Math.imul(a, b) >>> 0
function expand(w: number[], start = 16): void {
  for (let i = start; i < 64; i++) w[i] = (s1(w[i - 2]) + w[i - 7] + s0(w[i - 15]) + w[i - 16]) >>> 0
}
function compress(state: number[], w: number[], start = 0): number[] {
  let [a,b,c,d,e,f,g,h] = state
  for (let i = start; i < 64; i++) {
    const k = start === 14 && i === 14 ? 0xc9dc06a7 : rounds[i]
    const t1 = (h + (r(e,6) ^ r(e,11) ^ r(e,25)) + (g ^ (e & (f ^ g))) + k + w[i]) >>> 0
    const t2 = ((r(a,2) ^ r(a,13) ^ r(a,22)) + ((a & b) | (c & (a | b)))) >>> 0
    ;[a,b,c,d,e,f,g,h] = [(t1+t2)>>>0,a,b,c,(d+t1)>>>0,e,f,g]
  }
  return [a,b,c,d,e,f,g,h]
}
function digest(data: Uint8Array): Uint8Array {
  const w = Array<number>(14).fill(0)
  w.push(data[0]*65536+data[1]*256+data[2], new DataView(data.buffer).getUint32(3))
  for (let i=16;i<30;i++) {
    let value = schedule[i-16]
    if (i-2>=14) value += i===16 ? (s1(w[i-2]) ^ 0xb92c0) >>> 0 : s1(w[i-2])
    if (i-7>=14) value += w[i-7]
    if (i-15>=14) value += i===29 ? (s0(w[i-15]) ^ 0x59c0b80) >>> 0 : s0(w[i-15])
    w.push(value>>>0)
  }
  w.push((s1(w[28])+w[23]+s0(w[15])+w[14]+0xc9dc06a7-rounds[14])>>>0)
  expand(w,31)
  let st = compress([...state0],w,14).map((v,i)=>(v+initial[i])>>>0)
  const len=57+data.length
  const padded = new Uint8Array(data.length-7+1+((55-len)%64+64)%64+8)
  padded.set(data.subarray(7)); padded[data.length-7]=128
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length-8,BigInt(len*8))
  for(let off=0;off<padded.length;off+=64) {
    const block=Array.from({length:16},(_,i)=>view.getUint32(off+i*4))
    expand(block)
    st=compress(st,block).map((v,i)=>(v+st[i])>>>0)
  }
  const out=new Uint8Array(32), v=new DataView(out.buffer)
  st.forEach((n,i)=>v.setUint32(i*4,n))
  return out
}
export function edgeGec(unixSeconds = Date.now()/1000): string {
  const ticks = (Math.floor((unixSeconds+11644473600)/300)*300)*10000000
  const data=new TextEncoder().encode(`${ticks.toFixed(0)}6A5AA1D4EAFF4E9FB37E23D68491D6F4`)
  const hash=digest(data), view=new DataView(hash.buffer)
  const ka=(view.getUint32(0,true)|1)>>>0, kb=(view.getUint32(4,true)|1)>>>0
  const factors=[mul(ka,0x82893933),mul(kb,0x82893933)]
  const terms=coefficients.map((v,i)=>mul(v[0],factors[i%2])), offsets=coefficients.map(v=>v[1])
  const buf=new Uint8Array(Math.ceil((data.length+1)/8)*8);buf.set(data,1)
  const dv=new DataView(buf.buffer)
  for(let i=0;i<buf.length/4;i++) {
    const word=dv.getUint32(i*4,true)
    let term=mul(word,i%2===0?ka:kb), offset=mul(rol(word),i%2===0?0xef0569fb:0xc31713db)
    if(i===0){term=(term+mul(0xf2f90b1a,factors[0]))>>>0;offset=(offset+0xb1a0000)>>>0}
    terms.push(term);offsets.push(offset)
  }
  let swapAcc=0,swapLast=0,state=0,acc=0
  for(let i=0;i<terms.length;i+=2) {
    const x=terms[i],y=terms[i+1]
    let t=rol((offsets[i]+x)>>>0),q=mul(t,0x76f50f34)
    swapAcc=(swapAcc+mul(rol(q),0xc3efea97)+q)>>>0
    t=rol((offsets[i+1]+y)>>>0);q=mul(t,0x1881ce3c)
    swapLast=(mul(rol(q),0x35bd1ec9)+q)>>>0;swapAcc=(swapAcc+swapLast)>>>0
    state=(mul(state,ka)+x)>>>0
    for(const k of [0xcf98b111,0x87085b9f,0x12ceb96d,0x257e1d83])state=mul(rol(state),k)
    acc=(acc+state)>>>0;t=(mul(state,kb)+y)>>>0
    t=mul(rol(t),0xa27416f5);t=mul(rol(t),0xd38396ff);state=mul(rol(mul(rol(t),0x7c932b89)),0xbfa49f69)
    acc=(acc+state)>>>0
  }
  const cs=new Uint8Array(8), cv=new DataView(cs.buffer)
  cv.setUint32(0,(swapLast^state)>>>0,true);cv.setUint32(4,(swapAcc^acc)>>>0,true)
  const hex=(v:Uint8Array):string=>[...v].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase()
  return `${hex(cs)}-${hex(hash)}`
}
