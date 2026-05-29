import{F as xl,L as Dl,a as Ne,g as ee,i as ci,p as Qa,u as Nl,d as or,c as kl,b as Fl,_ as ja,e as Ml,f as Ol,I as It,h as Ll,j as ql,k as qr,l as Wa,m as Ul,E as Bl,X as zl,n as Gl,o as Ps,W as Er,q as $l,r as Ha,M as Kl,S as Io,s as Ql,t as jl,C as Wl,v as To,w as Hl}from"./vendor-firebase-core-D5lXZ75A.js";/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class re{constructor(e){this.uid=e}isAuthenticated(){return this.uid!=null}toKey(){return this.isAuthenticated()?"uid:"+this.uid:"anonymous-user"}isEqual(e){return e.uid===this.uid}}re.UNAUTHENTICATED=new re(null),re.GOOGLE_CREDENTIALS=new re("google-credentials-uid"),re.FIRST_PARTY=new re("first-party-uid"),re.MOCK_USER=new re("mock-user");/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */let yn="12.9.0";function Jl(r){yn=r}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *//**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Xe=new Dl("@firebase/firestore");function $t(){return Xe.logLevel}function e_(r){Xe.setLogLevel(r)}function p(r,...e){if(Xe.logLevel<=Ne.DEBUG){const t=e.map(li);Xe.debug(`Firestore (${yn}): ${r}`,...t)}}function H(r,...e){if(Xe.logLevel<=Ne.ERROR){const t=e.map(li);Xe.error(`Firestore (${yn}): ${r}`,...t)}}function Te(r,...e){if(Xe.logLevel<=Ne.WARN){const t=e.map(li);Xe.warn(`Firestore (${yn}): ${r}`,...t)}}function li(r){if(typeof r=="string")return r;try{return(function(t){return JSON.stringify(t)})(r)}catch{return r}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function A(r,e,t){let n="Unexpected state";typeof e=="string"?n=e:t=e,Ja(r,n,t)}function Ja(r,e,t){let n=`FIRESTORE (${yn}) INTERNAL ASSERTION FAILED: ${e} (ID: ${r.toString(16)})`;if(t!==void 0)try{n+=" CONTEXT: "+JSON.stringify(t)}catch{n+=" CONTEXT: "+t}throw H(n),new Error(n)}function v(r,e,t,n){let s="Unexpected state";typeof t=="string"?s=t:n=t,r||Ja(e,s,n)}function t_(r,e){r||A(57014,e)}function w(r,e){return r}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const m={OK:"ok",CANCELLED:"cancelled",UNKNOWN:"unknown",INVALID_ARGUMENT:"invalid-argument",DEADLINE_EXCEEDED:"deadline-exceeded",NOT_FOUND:"not-found",ALREADY_EXISTS:"already-exists",PERMISSION_DENIED:"permission-denied",UNAUTHENTICATED:"unauthenticated",RESOURCE_EXHAUSTED:"resource-exhausted",FAILED_PRECONDITION:"failed-precondition",ABORTED:"aborted",OUT_OF_RANGE:"out-of-range",UNIMPLEMENTED:"unimplemented",INTERNAL:"internal",UNAVAILABLE:"unavailable",DATA_LOSS:"data-loss"};class g extends xl{constructor(e,t){super(e,t),this.code=e,this.message=t,this.toString=()=>`${this.name}: [code=${this.code}]: ${this.message}`}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ie{constructor(){this.promise=new Promise(((e,t)=>{this.resolve=e,this.reject=t}))}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ya{constructor(e,t){this.user=t,this.type="OAuth",this.headers=new Map,this.headers.set("Authorization",`Bearer ${e}`)}}class Yl{getToken(){return Promise.resolve(null)}invalidateToken(){}start(e,t){e.enqueueRetryable((()=>t(re.UNAUTHENTICATED)))}shutdown(){}}class Xl{constructor(e){this.token=e,this.changeListener=null}getToken(){return Promise.resolve(this.token)}invalidateToken(){}start(e,t){this.changeListener=t,e.enqueueRetryable((()=>t(this.token.user)))}shutdown(){this.changeListener=null}}class Zl{constructor(e){this.t=e,this.currentUser=re.UNAUTHENTICATED,this.i=0,this.forceRefresh=!1,this.auth=null}start(e,t){v(this.o===void 0,42304);let n=this.i;const s=u=>this.i!==n?(n=this.i,t(u)):Promise.resolve();let i=new ie;this.o=()=>{this.i++,this.currentUser=this.u(),i.resolve(),i=new ie,e.enqueueRetryable((()=>s(this.currentUser)))};const o=()=>{const u=i;e.enqueueRetryable((async()=>{await u.promise,await s(this.currentUser)}))},a=u=>{p("FirebaseAuthCredentialsProvider","Auth detected"),this.auth=u,this.o&&(this.auth.addAuthTokenListener(this.o),o())};this.t.onInit((u=>a(u))),setTimeout((()=>{if(!this.auth){const u=this.t.getImmediate({optional:!0});u?a(u):(p("FirebaseAuthCredentialsProvider","Auth not yet detected"),i.resolve(),i=new ie)}}),0),o()}getToken(){const e=this.i,t=this.forceRefresh;return this.forceRefresh=!1,this.auth?this.auth.getToken(t).then((n=>this.i!==e?(p("FirebaseAuthCredentialsProvider","getToken aborted due to token change."),this.getToken()):n?(v(typeof n.accessToken=="string",31837,{l:n}),new Ya(n.accessToken,this.currentUser)):null)):Promise.resolve(null)}invalidateToken(){this.forceRefresh=!0}shutdown(){this.auth&&this.o&&this.auth.removeAuthTokenListener(this.o),this.o=void 0}u(){const e=this.auth&&this.auth.getUid();return v(e===null||typeof e=="string",2055,{h:e}),new re(e)}}class eh{constructor(e,t,n){this.P=e,this.T=t,this.I=n,this.type="FirstParty",this.user=re.FIRST_PARTY,this.R=new Map}A(){return this.I?this.I():null}get headers(){this.R.set("X-Goog-AuthUser",this.P);const e=this.A();return e&&this.R.set("Authorization",e),this.T&&this.R.set("X-Goog-Iam-Authorization-Token",this.T),this.R}}class th{constructor(e,t,n){this.P=e,this.T=t,this.I=n}getToken(){return Promise.resolve(new eh(this.P,this.T,this.I))}start(e,t){e.enqueueRetryable((()=>t(re.FIRST_PARTY)))}shutdown(){}invalidateToken(){}}class Os{constructor(e){this.value=e,this.type="AppCheck",this.headers=new Map,e&&e.length>0&&this.headers.set("x-firebase-appcheck",this.value)}}class nh{constructor(e,t){this.V=t,this.forceRefresh=!1,this.appCheck=null,this.m=null,this.p=null,Ql(e)&&e.settings.appCheckToken&&(this.p=e.settings.appCheckToken)}start(e,t){v(this.o===void 0,3512);const n=i=>{i.error!=null&&p("FirebaseAppCheckTokenProvider",`Error getting App Check token; using placeholder token instead. Error: ${i.error.message}`);const o=i.token!==this.m;return this.m=i.token,p("FirebaseAppCheckTokenProvider",`Received ${o?"new":"existing"} token.`),o?t(i.token):Promise.resolve()};this.o=i=>{e.enqueueRetryable((()=>n(i)))};const s=i=>{p("FirebaseAppCheckTokenProvider","AppCheck detected"),this.appCheck=i,this.o&&this.appCheck.addTokenListener(this.o)};this.V.onInit((i=>s(i))),setTimeout((()=>{if(!this.appCheck){const i=this.V.getImmediate({optional:!0});i?s(i):p("FirebaseAppCheckTokenProvider","AppCheck not yet detected")}}),0)}getToken(){if(this.p)return Promise.resolve(new Os(this.p));const e=this.forceRefresh;return this.forceRefresh=!1,this.appCheck?this.appCheck.getToken(e).then((t=>t?(v(typeof t.token=="string",44558,{tokenResult:t}),this.m=t.token,new Os(t.token)):null)):Promise.resolve(null)}invalidateToken(){this.forceRefresh=!0}shutdown(){this.appCheck&&this.o&&this.appCheck.removeTokenListener(this.o),this.o=void 0}}class n_{getToken(){return Promise.resolve(new Os(""))}invalidateToken(){}start(e,t){}shutdown(){}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function rh(r){const e=typeof self<"u"&&(self.crypto||self.msCrypto),t=new Uint8Array(r);if(e&&typeof e.getRandomValues=="function")e.getRandomValues(t);else for(let n=0;n<r;n++)t[n]=Math.floor(256*Math.random());return t}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class hi{static newId(){const e="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",t=62*Math.floor(4.129032258064516);let n="";for(;n.length<20;){const s=rh(40);for(let i=0;i<s.length;++i)n.length<20&&s[i]<t&&(n+=e.charAt(s[i]%62))}return n}}function P(r,e){return r<e?-1:r>e?1:0}function Ls(r,e){const t=Math.min(r.length,e.length);for(let n=0;n<t;n++){const s=r.charAt(n),i=e.charAt(n);if(s!==i)return bs(s)===bs(i)?P(s,i):bs(s)?1:-1}return P(r.length,e.length)}const sh=55296,ih=57343;function bs(r){const e=r.charCodeAt(0);return e>=sh&&e<=ih}function Yt(r,e,t){return r.length===e.length&&r.every(((n,s)=>t(n,e[s])))}function Xa(r){return r+"\0"}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const qs="__name__";class ve{constructor(e,t,n){t===void 0?t=0:t>e.length&&A(637,{offset:t,range:e.length}),n===void 0?n=e.length-t:n>e.length-t&&A(1746,{length:n,range:e.length-t}),this.segments=e,this.offset=t,this.len=n}get length(){return this.len}isEqual(e){return ve.comparator(this,e)===0}child(e){const t=this.segments.slice(this.offset,this.limit());return e instanceof ve?e.forEach((n=>{t.push(n)})):t.push(e),this.construct(t)}limit(){return this.offset+this.length}popFirst(e){return e=e===void 0?1:e,this.construct(this.segments,this.offset+e,this.length-e)}popLast(){return this.construct(this.segments,this.offset,this.length-1)}firstSegment(){return this.segments[this.offset]}lastSegment(){return this.get(this.length-1)}get(e){return this.segments[this.offset+e]}isEmpty(){return this.length===0}isPrefixOf(e){if(e.length<this.length)return!1;for(let t=0;t<this.length;t++)if(this.get(t)!==e.get(t))return!1;return!0}isImmediateParentOf(e){if(this.length+1!==e.length)return!1;for(let t=0;t<this.length;t++)if(this.get(t)!==e.get(t))return!1;return!0}forEach(e){for(let t=this.offset,n=this.limit();t<n;t++)e(this.segments[t])}toArray(){return this.segments.slice(this.offset,this.limit())}static comparator(e,t){const n=Math.min(e.length,t.length);for(let s=0;s<n;s++){const i=ve.compareSegments(e.get(s),t.get(s));if(i!==0)return i}return P(e.length,t.length)}static compareSegments(e,t){const n=ve.isNumericId(e),s=ve.isNumericId(t);return n&&!s?-1:!n&&s?1:n&&s?ve.extractNumericId(e).compare(ve.extractNumericId(t)):Ls(e,t)}static isNumericId(e){return e.startsWith("__id")&&e.endsWith("__")}static extractNumericId(e){return It.fromString(e.substring(4,e.length-2))}}class x extends ve{construct(e,t,n){return new x(e,t,n)}canonicalString(){return this.toArray().join("/")}toString(){return this.canonicalString()}toUriEncodedString(){return this.toArray().map(encodeURIComponent).join("/")}static fromString(...e){const t=[];for(const n of e){if(n.indexOf("//")>=0)throw new g(m.INVALID_ARGUMENT,`Invalid segment (${n}). Paths must not contain // in them.`);t.push(...n.split("/").filter((s=>s.length>0)))}return new x(t)}static emptyPath(){return new x([])}}const oh=/^[_a-zA-Z][_a-zA-Z0-9]*$/;class $ extends ve{construct(e,t,n){return new $(e,t,n)}static isValidIdentifier(e){return oh.test(e)}canonicalString(){return this.toArray().map((e=>(e=e.replace(/\\/g,"\\\\").replace(/`/g,"\\`"),$.isValidIdentifier(e)||(e="`"+e+"`"),e))).join(".")}toString(){return this.canonicalString()}isKeyField(){return this.length===1&&this.get(0)===qs}static keyField(){return new $([qs])}static fromServerFormat(e){const t=[];let n="",s=0;const i=()=>{if(n.length===0)throw new g(m.INVALID_ARGUMENT,`Invalid field path (${e}). Paths must not be empty, begin with '.', end with '.', or contain '..'`);t.push(n),n=""};let o=!1;for(;s<e.length;){const a=e[s];if(a==="\\"){if(s+1===e.length)throw new g(m.INVALID_ARGUMENT,"Path has trailing escape character: "+e);const u=e[s+1];if(u!=="\\"&&u!=="."&&u!=="`")throw new g(m.INVALID_ARGUMENT,"Path has invalid escape sequence: "+e);n+=u,s+=2}else a==="`"?(o=!o,s++):a!=="."||o?(n+=a,s++):(i(),s++)}if(i(),o)throw new g(m.INVALID_ARGUMENT,"Unterminated ` in path: "+e);return new $(t)}static emptyPath(){return new $([])}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class E{constructor(e){this.path=e}static fromPath(e){return new E(x.fromString(e))}static fromName(e){return new E(x.fromString(e).popFirst(5))}static empty(){return new E(x.emptyPath())}get collectionGroup(){return this.path.popLast().lastSegment()}hasCollectionId(e){return this.path.length>=2&&this.path.get(this.path.length-2)===e}getCollectionGroup(){return this.path.get(this.path.length-2)}getCollectionPath(){return this.path.popLast()}isEqual(e){return e!==null&&x.comparator(this.path,e.path)===0}toString(){return this.path.toString()}static comparator(e,t){return x.comparator(e.path,t.path)}static isDocumentKey(e){return e.length%2==0}static fromSegments(e){return new E(new x(e.slice()))}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function di(r,e,t){if(!t)throw new g(m.INVALID_ARGUMENT,`Function ${r}() cannot be called with an empty ${e}.`)}function ah(r,e,t,n){if(e===!0&&n===!0)throw new g(m.INVALID_ARGUMENT,`${r} and ${t} cannot be used together.`)}function Eo(r){if(!E.isDocumentKey(r))throw new g(m.INVALID_ARGUMENT,`Invalid document reference. Document references must have an even number of segments, but ${r} has ${r.length}.`)}function wo(r){if(E.isDocumentKey(r))throw new g(m.INVALID_ARGUMENT,`Invalid collection reference. Collection references must have an odd number of segments, but ${r} has ${r.length}.`)}function Za(r){return typeof r=="object"&&r!==null&&(Object.getPrototypeOf(r)===Object.prototype||Object.getPrototypeOf(r)===null)}function ts(r){if(r===void 0)return"undefined";if(r===null)return"null";if(typeof r=="string")return r.length>20&&(r=`${r.substring(0,20)}...`),JSON.stringify(r);if(typeof r=="number"||typeof r=="boolean")return""+r;if(typeof r=="object"){if(r instanceof Array)return"an array";{const e=(function(n){return n.constructor?n.constructor.name:null})(r);return e?`a custom ${e} object`:"an object"}}return typeof r=="function"?"a function":A(12329,{type:typeof r})}function D(r,e){if("_delegate"in r&&(r=r._delegate),!(r instanceof e)){if(e.name===r.constructor.name)throw new g(m.INVALID_ARGUMENT,"Type does not match the expected instance. Did you pass a reference from a different Firestore SDK?");{const t=ts(r);throw new g(m.INVALID_ARGUMENT,`Expected type '${e.name}', but it was: ${t}`)}}return r}function eu(r,e){if(e<=0)throw new g(m.INVALID_ARGUMENT,`Function ${r}() requires a positive number, but it was: ${e}.`)}/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function X(r,e){const t={typeString:r};return e&&(t.value=e),t}function Nt(r,e){if(!Za(r))throw new g(m.INVALID_ARGUMENT,"JSON must be an object");let t;for(const n in e)if(e[n]){const s=e[n].typeString,i="value"in e[n]?{value:e[n].value}:void 0;if(!(n in r)){t=`JSON missing required field: '${n}'`;break}const o=r[n];if(s&&typeof o!==s){t=`JSON field '${n}' must be a ${s}.`;break}if(i!==void 0&&o!==i.value){t=`Expected '${n}' field to equal '${i.value}'`;break}}if(t)throw new g(m.INVALID_ARGUMENT,t);return!0}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ao=-62135596800,vo=1e6;class F{static now(){return F.fromMillis(Date.now())}static fromDate(e){return F.fromMillis(e.getTime())}static fromMillis(e){const t=Math.floor(e/1e3),n=Math.floor((e-1e3*t)*vo);return new F(t,n)}constructor(e,t){if(this.seconds=e,this.nanoseconds=t,t<0)throw new g(m.INVALID_ARGUMENT,"Timestamp nanoseconds out of range: "+t);if(t>=1e9)throw new g(m.INVALID_ARGUMENT,"Timestamp nanoseconds out of range: "+t);if(e<Ao)throw new g(m.INVALID_ARGUMENT,"Timestamp seconds out of range: "+e);if(e>=253402300800)throw new g(m.INVALID_ARGUMENT,"Timestamp seconds out of range: "+e)}toDate(){return new Date(this.toMillis())}toMillis(){return 1e3*this.seconds+this.nanoseconds/vo}_compareTo(e){return this.seconds===e.seconds?P(this.nanoseconds,e.nanoseconds):P(this.seconds,e.seconds)}isEqual(e){return e.seconds===this.seconds&&e.nanoseconds===this.nanoseconds}toString(){return"Timestamp(seconds="+this.seconds+", nanoseconds="+this.nanoseconds+")"}toJSON(){return{type:F._jsonSchemaVersion,seconds:this.seconds,nanoseconds:this.nanoseconds}}static fromJSON(e){if(Nt(e,F._jsonSchema))return new F(e.seconds,e.nanoseconds)}valueOf(){const e=this.seconds-Ao;return String(e).padStart(12,"0")+"."+String(this.nanoseconds).padStart(9,"0")}}F._jsonSchemaVersion="firestore/timestamp/1.0",F._jsonSchema={type:X("string",F._jsonSchemaVersion),seconds:X("number"),nanoseconds:X("number")};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class R{static fromTimestamp(e){return new R(e)}static min(){return new R(new F(0,0))}static max(){return new R(new F(253402300799,999999999))}constructor(e){this.timestamp=e}compareTo(e){return this.timestamp._compareTo(e.timestamp)}isEqual(e){return this.timestamp.isEqual(e.timestamp)}toMicroseconds(){return 1e6*this.timestamp.seconds+this.timestamp.nanoseconds/1e3}toString(){return"SnapshotVersion("+this.timestamp.toString()+")"}toTimestamp(){return this.timestamp}}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Xt=-1;class Zt{constructor(e,t,n,s){this.indexId=e,this.collectionGroup=t,this.fields=n,this.indexState=s}}function Us(r){return r.fields.find((e=>e.kind===2))}function dt(r){return r.fields.filter((e=>e.kind!==2))}function uh(r,e){let t=P(r.collectionGroup,e.collectionGroup);if(t!==0)return t;for(let n=0;n<Math.min(r.fields.length,e.fields.length);++n)if(t=ch(r.fields[n],e.fields[n]),t!==0)return t;return P(r.fields.length,e.fields.length)}Zt.UNKNOWN_ID=-1;class Tt{constructor(e,t){this.fieldPath=e,this.kind=t}}function ch(r,e){const t=$.comparator(r.fieldPath,e.fieldPath);return t!==0?t:P(r.kind,e.kind)}class en{constructor(e,t){this.sequenceNumber=e,this.offset=t}static empty(){return new en(0,Ee.min())}}function tu(r,e){const t=r.toTimestamp().seconds,n=r.toTimestamp().nanoseconds+1,s=R.fromTimestamp(n===1e9?new F(t+1,0):new F(t,n));return new Ee(s,E.empty(),e)}function nu(r){return new Ee(r.readTime,r.key,Xt)}class Ee{constructor(e,t,n){this.readTime=e,this.documentKey=t,this.largestBatchId=n}static min(){return new Ee(R.min(),E.empty(),Xt)}static max(){return new Ee(R.max(),E.empty(),Xt)}}function fi(r,e){let t=r.readTime.compareTo(e.readTime);return t!==0?t:(t=E.comparator(r.documentKey,e.documentKey),t!==0?t:P(r.largestBatchId,e.largestBatchId))}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ru="The current tab is not in the required state to perform this operation. It might be necessary to refresh the browser tab.";class su{constructor(){this.onCommittedListeners=[]}addOnCommittedListener(e){this.onCommittedListeners.push(e)}raiseOnCommittedEvent(){this.onCommittedListeners.forEach((e=>e()))}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function it(r){if(r.code!==m.FAILED_PRECONDITION||r.message!==ru)throw r;p("LocalStore","Unexpectedly lost primary lease")}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class f{constructor(e){this.nextCallback=null,this.catchCallback=null,this.result=void 0,this.error=void 0,this.isDone=!1,this.callbackAttached=!1,e((t=>{this.isDone=!0,this.result=t,this.nextCallback&&this.nextCallback(t)}),(t=>{this.isDone=!0,this.error=t,this.catchCallback&&this.catchCallback(t)}))}catch(e){return this.next(void 0,e)}next(e,t){return this.callbackAttached&&A(59440),this.callbackAttached=!0,this.isDone?this.error?this.wrapFailure(t,this.error):this.wrapSuccess(e,this.result):new f(((n,s)=>{this.nextCallback=i=>{this.wrapSuccess(e,i).next(n,s)},this.catchCallback=i=>{this.wrapFailure(t,i).next(n,s)}}))}toPromise(){return new Promise(((e,t)=>{this.next(e,t)}))}wrapUserFunction(e){try{const t=e();return t instanceof f?t:f.resolve(t)}catch(t){return f.reject(t)}}wrapSuccess(e,t){return e?this.wrapUserFunction((()=>e(t))):f.resolve(t)}wrapFailure(e,t){return e?this.wrapUserFunction((()=>e(t))):f.reject(t)}static resolve(e){return new f(((t,n)=>{t(e)}))}static reject(e){return new f(((t,n)=>{n(e)}))}static waitFor(e){return new f(((t,n)=>{let s=0,i=0,o=!1;e.forEach((a=>{++s,a.next((()=>{++i,o&&i===s&&t()}),(u=>n(u)))})),o=!0,i===s&&t()}))}static or(e){let t=f.resolve(!1);for(const n of e)t=t.next((s=>s?f.resolve(s):n()));return t}static forEach(e,t){const n=[];return e.forEach(((s,i)=>{n.push(t.call(this,s,i))})),this.waitFor(n)}static mapArray(e,t){return new f(((n,s)=>{const i=e.length,o=new Array(i);let a=0;for(let u=0;u<i;u++){const c=u;t(e[c]).next((l=>{o[c]=l,++a,a===i&&n(o)}),(l=>s(l)))}}))}static doWhile(e,t){return new f(((n,s)=>{const i=()=>{e()===!0?t().next((()=>{i()}),s):n()};i()}))}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ge="SimpleDb";class ns{static open(e,t,n,s){try{return new ns(t,e.transaction(s,n))}catch(i){throw new Ln(t,i)}}constructor(e,t){this.action=e,this.transaction=t,this.aborted=!1,this.S=new ie,this.transaction.oncomplete=()=>{this.S.resolve()},this.transaction.onabort=()=>{t.error?this.S.reject(new Ln(e,t.error)):this.S.resolve()},this.transaction.onerror=n=>{const s=mi(n.target.error);this.S.reject(new Ln(e,s))}}get D(){return this.S.promise}abort(e){e&&this.S.reject(e),this.aborted||(p(ge,"Aborting transaction:",e?e.message:"Client-initiated abort"),this.aborted=!0,this.transaction.abort())}C(){const e=this.transaction;this.aborted||typeof e.commit!="function"||e.commit()}store(e){const t=this.transaction.objectStore(e);return new hh(t)}}class be{static delete(e){return p(ge,"Removing database:",e),mt(Ll().indexedDB.deleteDatabase(e)).toPromise()}static v(){if(!ql())return!1;if(be.F())return!0;const e=qr(),t=be.M(e),n=0<t&&t<10,s=iu(e),i=0<s&&s<4.5;return!(e.indexOf("MSIE ")>0||e.indexOf("Trident/")>0||e.indexOf("Edge/")>0||n||i)}static F(){var e;return typeof process<"u"&&((e=process.__PRIVATE_env)==null?void 0:e.__PRIVATE_USE_MOCK_PERSISTENCE)==="YES"}static O(e,t){return e.store(t)}static M(e){const t=e.match(/i(?:phone|pad|pod) os ([\d_]+)/i),n=t?t[1].split("_").slice(0,2).join("."):"-1";return Number(n)}constructor(e,t,n){this.name=e,this.version=t,this.N=n,this.B=null,be.M(qr())===12.2&&H("Firestore persistence suffers from a bug in iOS 12.2 Safari that may cause your app to stop working. See https://stackoverflow.com/q/56496296/110915 for details and a potential workaround.")}async L(e){return this.db||(p(ge,"Opening database:",this.name),this.db=await new Promise(((t,n)=>{const s=indexedDB.open(this.name,this.version);s.onsuccess=i=>{const o=i.target.result;t(o)},s.onblocked=()=>{n(new Ln(e,"Cannot upgrade IndexedDB schema while another tab is open. Close all tabs that access Firestore and reload this page to proceed."))},s.onerror=i=>{const o=i.target.error;o.name==="VersionError"?n(new g(m.FAILED_PRECONDITION,"A newer version of the Firestore SDK was previously used and so the persisted data is not compatible with the version of the SDK you are now using. The SDK will operate with persistence disabled. If you need persistence, please re-upgrade to a newer version of the SDK or else clear the persisted IndexedDB data for your app to start fresh.")):o.name==="InvalidStateError"?n(new g(m.FAILED_PRECONDITION,"Unable to open an IndexedDB connection. This could be due to running in a private browsing session on a browser whose private browsing sessions do not support IndexedDB: "+o)):n(new Ln(e,o))},s.onupgradeneeded=i=>{p(ge,'Database "'+this.name+'" requires upgrade from version:',i.oldVersion);const o=i.target.result;this.N.k(o,s.transaction,i.oldVersion,this.version).next((()=>{p(ge,"Database upgrade to version "+this.version+" complete")}))}}))),this.K&&(this.db.onversionchange=t=>this.K(t)),this.db}q(e){this.K=e,this.db&&(this.db.onversionchange=t=>e(t))}async runTransaction(e,t,n,s){const i=t==="readonly";let o=0;for(;;){++o;try{this.db=await this.L(e);const a=ns.open(this.db,e,i?"readonly":"readwrite",n),u=s(a).next((c=>(a.C(),c))).catch((c=>(a.abort(c),f.reject(c)))).toPromise();return u.catch((()=>{})),await a.D,u}catch(a){const u=a,c=u.name!=="FirebaseError"&&o<3;if(p(ge,"Transaction failed with error:",u.message,"Retrying:",c),this.close(),!c)return Promise.reject(u)}}}close(){this.db&&this.db.close(),this.db=void 0}}function iu(r){const e=r.match(/Android ([\d.]+)/i),t=e?e[1].split(".").slice(0,2).join("."):"-1";return Number(t)}class lh{constructor(e){this.U=e,this.$=!1,this.W=null}get isDone(){return this.$}get G(){return this.W}set cursor(e){this.U=e}done(){this.$=!0}j(e){this.W=e}delete(){return mt(this.U.delete())}}class Ln extends g{constructor(e,t){super(m.UNAVAILABLE,`IndexedDB transaction '${e}' failed: ${t}`),this.name="IndexedDbTransactionError"}}function ot(r){return r.name==="IndexedDbTransactionError"}class hh{constructor(e){this.store=e}put(e,t){let n;return t!==void 0?(p(ge,"PUT",this.store.name,e,t),n=this.store.put(t,e)):(p(ge,"PUT",this.store.name,"<auto-key>",e),n=this.store.put(e)),mt(n)}add(e){return p(ge,"ADD",this.store.name,e,e),mt(this.store.add(e))}get(e){return mt(this.store.get(e)).next((t=>(t===void 0&&(t=null),p(ge,"GET",this.store.name,e,t),t)))}delete(e){return p(ge,"DELETE",this.store.name,e),mt(this.store.delete(e))}count(){return p(ge,"COUNT",this.store.name),mt(this.store.count())}H(e,t){const n=this.options(e,t),s=n.index?this.store.index(n.index):this.store;if(typeof s.getAll=="function"){const i=s.getAll(n.range);return new f(((o,a)=>{i.onerror=u=>{a(u.target.error)},i.onsuccess=u=>{o(u.target.result)}}))}{const i=this.cursor(n),o=[];return this.J(i,((a,u)=>{o.push(u)})).next((()=>o))}}Z(e,t){const n=this.store.getAll(e,t===null?void 0:t);return new f(((s,i)=>{n.onerror=o=>{i(o.target.error)},n.onsuccess=o=>{s(o.target.result)}}))}X(e,t){p(ge,"DELETE ALL",this.store.name);const n=this.options(e,t);n.Y=!1;const s=this.cursor(n);return this.J(s,((i,o,a)=>a.delete()))}ee(e,t){let n;t?n=e:(n={},t=e);const s=this.cursor(n);return this.J(s,t)}te(e){const t=this.cursor({});return new f(((n,s)=>{t.onerror=i=>{const o=mi(i.target.error);s(o)},t.onsuccess=i=>{const o=i.target.result;o?e(o.primaryKey,o.value).next((a=>{a?o.continue():n()})):n()}}))}J(e,t){const n=[];return new f(((s,i)=>{e.onerror=o=>{i(o.target.error)},e.onsuccess=o=>{const a=o.target.result;if(!a)return void s();const u=new lh(a),c=t(a.primaryKey,a.value,u);if(c instanceof f){const l=c.catch((h=>(u.done(),f.reject(h))));n.push(l)}u.isDone?s():u.G===null?a.continue():a.continue(u.G)}})).next((()=>f.waitFor(n)))}options(e,t){let n;return e!==void 0&&(typeof e=="string"?n=e:t=e),{index:n,range:t}}cursor(e){let t="next";if(e.reverse&&(t="prev"),e.index){const n=this.store.index(e.index);return e.Y?n.openKeyCursor(e.range,t):n.openCursor(e.range,t)}return this.store.openCursor(e.range,t)}}function mt(r){return new f(((e,t)=>{r.onsuccess=n=>{const s=n.target.result;e(s)},r.onerror=n=>{const s=mi(n.target.error);t(s)}}))}let Ro=!1;function mi(r){const e=be.M(qr());if(e>=12.2&&e<13){const t="An internal error was encountered in the Indexed Database server";if(r.message.indexOf(t)>=0){const n=new g("internal",`IOS_INDEXEDDB_BUG1: IndexedDb has thrown '${t}'. This is likely due to an unavoidable bug in iOS. See https://stackoverflow.com/q/56496296/110915 for details and a potential workaround.`);return Ro||(Ro=!0,setTimeout((()=>{throw n}),0)),n}}return r}const qn="IndexBackfiller";class dh{constructor(e,t){this.asyncQueue=e,this.ne=t,this.task=null}start(){this.re(15e3)}stop(){this.task&&(this.task.cancel(),this.task=null)}get started(){return this.task!==null}re(e){p(qn,`Scheduled in ${e}ms`),this.task=this.asyncQueue.enqueueAfterDelay("index_backfill",e,(async()=>{this.task=null;try{const t=await this.ne.ie();p(qn,`Documents written: ${t}`)}catch(t){ot(t)?p(qn,"Ignoring IndexedDB error during index backfill: ",t):await it(t)}await this.re(6e4)}))}}class fh{constructor(e,t){this.localStore=e,this.persistence=t}async ie(e=50){return this.persistence.runTransaction("Backfill Indexes","readwrite-primary",(t=>this.se(t,e)))}se(e,t){const n=new Set;let s=t,i=!0;return f.doWhile((()=>i===!0&&s>0),(()=>this.localStore.indexManager.getNextCollectionGroupToUpdate(e).next((o=>{if(o!==null&&!n.has(o))return p(qn,`Processing collection: ${o}`),this.oe(e,o,s).next((a=>{s-=a,n.add(o)}));i=!1})))).next((()=>t-s))}oe(e,t,n){return this.localStore.indexManager.getMinOffsetFromCollectionGroup(e,t).next((s=>this.localStore.localDocuments.getNextDocuments(e,t,s,n).next((i=>{const o=i.changes;return this.localStore.indexManager.updateIndexEntries(e,o).next((()=>this._e(s,i))).next((a=>(p(qn,`Updating offset: ${a}`),this.localStore.indexManager.updateCollectionGroup(e,t,a)))).next((()=>o.size))}))))}_e(e,t){let n=e;return t.changes.forEach(((s,i)=>{const o=nu(i);fi(o,n)>0&&(n=o)})),new Ee(n.readTime,n.documentKey,Math.max(t.batchId,e.largestBatchId))}}/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class fe{constructor(e,t){this.previousValue=e,t&&(t.sequenceNumberHandler=n=>this.ae(n),this.ue=n=>t.writeSequenceNumber(n))}ae(e){return this.previousValue=Math.max(e,this.previousValue),this.previousValue}next(){const e=++this.previousValue;return this.ue&&this.ue(e),e}}fe.ce=-1;/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ye=-1;function ar(r){return r==null}function jn(r){return r===0&&1/r==-1/0}function ou(r){return typeof r=="number"&&Number.isInteger(r)&&!jn(r)&&r<=Number.MAX_SAFE_INTEGER&&r>=Number.MIN_SAFE_INTEGER}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ur="";function le(r){let e="";for(let t=0;t<r.length;t++)e.length>0&&(e=Vo(e)),e=mh(r.get(t),e);return Vo(e)}function mh(r,e){let t=e;const n=r.length;for(let s=0;s<n;s++){const i=r.charAt(s);switch(i){case"\0":t+="";break;case Ur:t+="";break;default:t+=i}}return t}function Vo(r){return r+Ur+""}function Ve(r){const e=r.length;if(v(e>=2,64408,{path:r}),e===2)return v(r.charAt(0)===Ur&&r.charAt(1)==="",56145,{path:r}),x.emptyPath();const t=e-2,n=[];let s="";for(let i=0;i<e;){const o=r.indexOf(Ur,i);switch((o<0||o>t)&&A(50515,{path:r}),r.charAt(o+1)){case"":const a=r.substring(i,o);let u;s.length===0?u=a:(s+=a,u=s,s=""),n.push(u);break;case"":s+=r.substring(i,o),s+="\0";break;case"":s+=r.substring(i,o+1);break;default:A(61167,{path:r})}i=o+2}return new x(n)}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ft="remoteDocuments",ur="owner",Lt="owner",Wn="mutationQueues",_h="userId",Ae="mutations",Po="batchId",yt="userMutationsIndex",bo=["userId","batchId"];/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Sr(r,e){return[r,le(e)]}function au(r,e,t){return[r,le(e),t]}const gh={},tn="documentMutations",Br="remoteDocumentsV14",ph=["prefixPath","collectionGroup","readTime","documentId"],Cr="documentKeyIndex",yh=["prefixPath","collectionGroup","documentId"],uu="collectionGroupIndex",Ih=["collectionGroup","readTime","prefixPath","documentId"],Hn="remoteDocumentGlobal",Bs="remoteDocumentGlobalKey",nn="targets",cu="queryTargetsIndex",Th=["canonicalId","targetId"],rn="targetDocuments",Eh=["targetId","path"],_i="documentTargetsIndex",wh=["path","targetId"],zr="targetGlobalKey",Et="targetGlobal",Jn="collectionParents",Ah=["collectionId","parent"],sn="clientMetadata",vh="clientId",rs="bundles",Rh="bundleId",ss="namedQueries",Vh="name",gi="indexConfiguration",Ph="indexId",zs="collectionGroupIndex",bh="collectionGroup",Un="indexState",Sh=["indexId","uid"],lu="sequenceNumberIndex",Ch=["uid","sequenceNumber"],Bn="indexEntries",xh=["indexId","uid","arrayValue","directionalValue","orderedDocumentKey","documentKey"],hu="documentKeyIndex",Dh=["indexId","uid","orderedDocumentKey"],is="documentOverlays",Nh=["userId","collectionPath","documentId"],Gs="collectionPathOverlayIndex",kh=["userId","collectionPath","largestBatchId"],du="collectionGroupOverlayIndex",Fh=["userId","collectionGroup","largestBatchId"],pi="globals",Mh="name",fu=[Wn,Ae,tn,ft,nn,ur,Et,rn,sn,Hn,Jn,rs,ss],Oh=[...fu,is],mu=[Wn,Ae,tn,Br,nn,ur,Et,rn,sn,Hn,Jn,rs,ss,is],_u=mu,yi=[..._u,gi,Un,Bn],Lh=yi,gu=[...yi,pi],qh=gu;/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class $s extends su{constructor(e,t){super(),this.le=e,this.currentSequenceNumber=t}}function te(r,e){const t=w(r);return be.O(t.le,e)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function So(r){let e=0;for(const t in r)Object.prototype.hasOwnProperty.call(r,t)&&e++;return e}function at(r,e){for(const t in r)Object.prototype.hasOwnProperty.call(r,t)&&e(t,r[t])}function pu(r,e){const t=[];for(const n in r)Object.prototype.hasOwnProperty.call(r,n)&&t.push(e(r[n],n,r));return t}function yu(r){for(const e in r)if(Object.prototype.hasOwnProperty.call(r,e))return!1;return!0}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class U{constructor(e,t){this.comparator=e,this.root=t||ae.EMPTY}insert(e,t){return new U(this.comparator,this.root.insert(e,t,this.comparator).copy(null,null,ae.BLACK,null,null))}remove(e){return new U(this.comparator,this.root.remove(e,this.comparator).copy(null,null,ae.BLACK,null,null))}get(e){let t=this.root;for(;!t.isEmpty();){const n=this.comparator(e,t.key);if(n===0)return t.value;n<0?t=t.left:n>0&&(t=t.right)}return null}indexOf(e){let t=0,n=this.root;for(;!n.isEmpty();){const s=this.comparator(e,n.key);if(s===0)return t+n.left.size;s<0?n=n.left:(t+=n.left.size+1,n=n.right)}return-1}isEmpty(){return this.root.isEmpty()}get size(){return this.root.size}minKey(){return this.root.minKey()}maxKey(){return this.root.maxKey()}inorderTraversal(e){return this.root.inorderTraversal(e)}forEach(e){this.inorderTraversal(((t,n)=>(e(t,n),!1)))}toString(){const e=[];return this.inorderTraversal(((t,n)=>(e.push(`${t}:${n}`),!1))),`{${e.join(", ")}}`}reverseTraversal(e){return this.root.reverseTraversal(e)}getIterator(){return new wr(this.root,null,this.comparator,!1)}getIteratorFrom(e){return new wr(this.root,e,this.comparator,!1)}getReverseIterator(){return new wr(this.root,null,this.comparator,!0)}getReverseIteratorFrom(e){return new wr(this.root,e,this.comparator,!0)}}class wr{constructor(e,t,n,s){this.isReverse=s,this.nodeStack=[];let i=1;for(;!e.isEmpty();)if(i=t?n(e.key,t):1,t&&s&&(i*=-1),i<0)e=this.isReverse?e.left:e.right;else{if(i===0){this.nodeStack.push(e);break}this.nodeStack.push(e),e=this.isReverse?e.right:e.left}}getNext(){let e=this.nodeStack.pop();const t={key:e.key,value:e.value};if(this.isReverse)for(e=e.left;!e.isEmpty();)this.nodeStack.push(e),e=e.right;else for(e=e.right;!e.isEmpty();)this.nodeStack.push(e),e=e.left;return t}hasNext(){return this.nodeStack.length>0}peek(){if(this.nodeStack.length===0)return null;const e=this.nodeStack[this.nodeStack.length-1];return{key:e.key,value:e.value}}}class ae{constructor(e,t,n,s,i){this.key=e,this.value=t,this.color=n??ae.RED,this.left=s??ae.EMPTY,this.right=i??ae.EMPTY,this.size=this.left.size+1+this.right.size}copy(e,t,n,s,i){return new ae(e??this.key,t??this.value,n??this.color,s??this.left,i??this.right)}isEmpty(){return!1}inorderTraversal(e){return this.left.inorderTraversal(e)||e(this.key,this.value)||this.right.inorderTraversal(e)}reverseTraversal(e){return this.right.reverseTraversal(e)||e(this.key,this.value)||this.left.reverseTraversal(e)}min(){return this.left.isEmpty()?this:this.left.min()}minKey(){return this.min().key}maxKey(){return this.right.isEmpty()?this.key:this.right.maxKey()}insert(e,t,n){let s=this;const i=n(e,s.key);return s=i<0?s.copy(null,null,null,s.left.insert(e,t,n),null):i===0?s.copy(null,t,null,null,null):s.copy(null,null,null,null,s.right.insert(e,t,n)),s.fixUp()}removeMin(){if(this.left.isEmpty())return ae.EMPTY;let e=this;return e.left.isRed()||e.left.left.isRed()||(e=e.moveRedLeft()),e=e.copy(null,null,null,e.left.removeMin(),null),e.fixUp()}remove(e,t){let n,s=this;if(t(e,s.key)<0)s.left.isEmpty()||s.left.isRed()||s.left.left.isRed()||(s=s.moveRedLeft()),s=s.copy(null,null,null,s.left.remove(e,t),null);else{if(s.left.isRed()&&(s=s.rotateRight()),s.right.isEmpty()||s.right.isRed()||s.right.left.isRed()||(s=s.moveRedRight()),t(e,s.key)===0){if(s.right.isEmpty())return ae.EMPTY;n=s.right.min(),s=s.copy(n.key,n.value,null,null,s.right.removeMin())}s=s.copy(null,null,null,null,s.right.remove(e,t))}return s.fixUp()}isRed(){return this.color}fixUp(){let e=this;return e.right.isRed()&&!e.left.isRed()&&(e=e.rotateLeft()),e.left.isRed()&&e.left.left.isRed()&&(e=e.rotateRight()),e.left.isRed()&&e.right.isRed()&&(e=e.colorFlip()),e}moveRedLeft(){let e=this.colorFlip();return e.right.left.isRed()&&(e=e.copy(null,null,null,null,e.right.rotateRight()),e=e.rotateLeft(),e=e.colorFlip()),e}moveRedRight(){let e=this.colorFlip();return e.left.left.isRed()&&(e=e.rotateRight(),e=e.colorFlip()),e}rotateLeft(){const e=this.copy(null,null,ae.RED,null,this.right.left);return this.right.copy(null,null,this.color,e,null)}rotateRight(){const e=this.copy(null,null,ae.RED,this.left.right,null);return this.left.copy(null,null,this.color,null,e)}colorFlip(){const e=this.left.copy(null,null,!this.left.color,null,null),t=this.right.copy(null,null,!this.right.color,null,null);return this.copy(null,null,!this.color,e,t)}checkMaxDepth(){const e=this.check();return Math.pow(2,e)<=this.size+1}check(){if(this.isRed()&&this.left.isRed())throw A(43730,{key:this.key,value:this.value});if(this.right.isRed())throw A(14113,{key:this.key,value:this.value});const e=this.left.check();if(e!==this.right.check())throw A(27949);return e+(this.isRed()?0:1)}}ae.EMPTY=null,ae.RED=!0,ae.BLACK=!1;ae.EMPTY=new class{constructor(){this.size=0}get key(){throw A(57766)}get value(){throw A(16141)}get color(){throw A(16727)}get left(){throw A(29726)}get right(){throw A(36894)}copy(e,t,n,s,i){return this}insert(e,t,n){return new ae(e,t)}remove(e,t){return this}isEmpty(){return!0}inorderTraversal(e){return!1}reverseTraversal(e){return!1}minKey(){return null}maxKey(){return null}isRed(){return!1}checkMaxDepth(){return!0}check(){return 0}};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class O{constructor(e){this.comparator=e,this.data=new U(this.comparator)}has(e){return this.data.get(e)!==null}first(){return this.data.minKey()}last(){return this.data.maxKey()}get size(){return this.data.size}indexOf(e){return this.data.indexOf(e)}forEach(e){this.data.inorderTraversal(((t,n)=>(e(t),!1)))}forEachInRange(e,t){const n=this.data.getIteratorFrom(e[0]);for(;n.hasNext();){const s=n.getNext();if(this.comparator(s.key,e[1])>=0)return;t(s.key)}}forEachWhile(e,t){let n;for(n=t!==void 0?this.data.getIteratorFrom(t):this.data.getIterator();n.hasNext();)if(!e(n.getNext().key))return}firstAfterOrEqual(e){const t=this.data.getIteratorFrom(e);return t.hasNext()?t.getNext().key:null}getIterator(){return new Co(this.data.getIterator())}getIteratorFrom(e){return new Co(this.data.getIteratorFrom(e))}add(e){return this.copy(this.data.remove(e).insert(e,!0))}delete(e){return this.has(e)?this.copy(this.data.remove(e)):this}isEmpty(){return this.data.isEmpty()}unionWith(e){let t=this;return t.size<e.size&&(t=e,e=this),e.forEach((n=>{t=t.add(n)})),t}isEqual(e){if(!(e instanceof O)||this.size!==e.size)return!1;const t=this.data.getIterator(),n=e.data.getIterator();for(;t.hasNext();){const s=t.getNext().key,i=n.getNext().key;if(this.comparator(s,i)!==0)return!1}return!0}toArray(){const e=[];return this.forEach((t=>{e.push(t)})),e}toString(){const e=[];return this.forEach((t=>e.push(t))),"SortedSet("+e.toString()+")"}copy(e){const t=new O(this.comparator);return t.data=e,t}}class Co{constructor(e){this.iter=e}getNext(){return this.iter.getNext().key}hasNext(){return this.iter.hasNext()}}function qt(r){return r.hasNext()?r.getNext():void 0}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class me{constructor(e){this.fields=e,e.sort($.comparator)}static empty(){return new me([])}unionWith(e){let t=new O($.comparator);for(const n of this.fields)t=t.add(n);for(const n of e)t=t.add(n);return new me(t.toArray())}covers(e){for(const t of this.fields)if(t.isPrefixOf(e))return!0;return!1}isEqual(e){return Yt(this.fields,e.fields,((t,n)=>t.isEqual(n)))}}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Iu extends Error{constructor(){super(...arguments),this.name="Base64DecodeError"}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function s_(){return typeof atob<"u"}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class W{constructor(e){this.binaryString=e}static fromBase64String(e){const t=(function(s){try{return atob(s)}catch(i){throw typeof DOMException<"u"&&i instanceof DOMException?new Iu("Invalid base64 string: "+i):i}})(e);return new W(t)}static fromUint8Array(e){const t=(function(s){let i="";for(let o=0;o<s.length;++o)i+=String.fromCharCode(s[o]);return i})(e);return new W(t)}[Symbol.iterator](){let e=0;return{next:()=>e<this.binaryString.length?{value:this.binaryString.charCodeAt(e++),done:!1}:{value:void 0,done:!0}}}toBase64(){return(function(t){return btoa(t)})(this.binaryString)}toUint8Array(){return(function(t){const n=new Uint8Array(t.length);for(let s=0;s<t.length;s++)n[s]=t.charCodeAt(s);return n})(this.binaryString)}approximateByteSize(){return 2*this.binaryString.length}compareTo(e){return P(this.binaryString,e.binaryString)}isEqual(e){return this.binaryString===e.binaryString}}W.EMPTY_BYTE_STRING=new W("");const Uh=new RegExp(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d+))?Z$/);function Fe(r){if(v(!!r,39018),typeof r=="string"){let e=0;const t=Uh.exec(r);if(v(!!t,46558,{timestamp:r}),t[1]){let s=t[1];s=(s+"000000000").substr(0,9),e=Number(s)}const n=new Date(r);return{seconds:Math.floor(n.getTime()/1e3),nanos:e}}return{seconds:G(r.seconds),nanos:G(r.nanos)}}function G(r){return typeof r=="number"?r:typeof r=="string"?Number(r):0}function Me(r){return typeof r=="string"?W.fromBase64String(r):W.fromUint8Array(r)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Tu="server_timestamp",Eu="__type__",wu="__previous_value__",Au="__local_write_time__";function os(r){var t,n;return((n=(((t=r==null?void 0:r.mapValue)==null?void 0:t.fields)||{})[Eu])==null?void 0:n.stringValue)===Tu}function as(r){const e=r.mapValue.fields[wu];return os(e)?as(e):e}function Yn(r){const e=Fe(r.mapValue.fields[Au].timestampValue);return new F(e.seconds,e.nanos)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Bh{constructor(e,t,n,s,i,o,a,u,c,l,h){this.databaseId=e,this.appId=t,this.persistenceKey=n,this.host=s,this.ssl=i,this.forceLongPolling=o,this.autoDetectLongPolling=a,this.longPollingOptions=u,this.useFetchStreams=c,this.isUsingEmulator=l,this.apiKey=h}}const Xn="(default)";class At{constructor(e,t){this.projectId=e,this.database=t||Xn}static empty(){return new At("","")}get isDefaultDatabase(){return this.database===Xn}isEqual(e){return e instanceof At&&e.projectId===this.projectId&&e.database===this.database}}function zh(r,e){if(!Object.prototype.hasOwnProperty.apply(r.options,["projectId"]))throw new g(m.INVALID_ARGUMENT,'"projectId" not provided in firebase.initializeApp.');return new At(r.options.projectId,e)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ii="__type__",vu="__max__",We={mapValue:{fields:{__type__:{stringValue:vu}}}},Ti="__vector__",on="value",xr={nullValue:"NULL_VALUE"};function Ze(r){return"nullValue"in r?0:"booleanValue"in r?1:"integerValue"in r||"doubleValue"in r?2:"timestampValue"in r?3:"stringValue"in r?5:"bytesValue"in r?6:"referenceValue"in r?7:"geoPointValue"in r?8:"arrayValue"in r?9:"mapValue"in r?os(r)?4:Ru(r)?9007199254740991:us(r)?10:11:A(28295,{value:r})}function De(r,e){if(r===e)return!0;const t=Ze(r);if(t!==Ze(e))return!1;switch(t){case 0:case 9007199254740991:return!0;case 1:return r.booleanValue===e.booleanValue;case 4:return Yn(r).isEqual(Yn(e));case 3:return(function(s,i){if(typeof s.timestampValue=="string"&&typeof i.timestampValue=="string"&&s.timestampValue.length===i.timestampValue.length)return s.timestampValue===i.timestampValue;const o=Fe(s.timestampValue),a=Fe(i.timestampValue);return o.seconds===a.seconds&&o.nanos===a.nanos})(r,e);case 5:return r.stringValue===e.stringValue;case 6:return(function(s,i){return Me(s.bytesValue).isEqual(Me(i.bytesValue))})(r,e);case 7:return r.referenceValue===e.referenceValue;case 8:return(function(s,i){return G(s.geoPointValue.latitude)===G(i.geoPointValue.latitude)&&G(s.geoPointValue.longitude)===G(i.geoPointValue.longitude)})(r,e);case 2:return(function(s,i){if("integerValue"in s&&"integerValue"in i)return G(s.integerValue)===G(i.integerValue);if("doubleValue"in s&&"doubleValue"in i){const o=G(s.doubleValue),a=G(i.doubleValue);return o===a?jn(o)===jn(a):isNaN(o)&&isNaN(a)}return!1})(r,e);case 9:return Yt(r.arrayValue.values||[],e.arrayValue.values||[],De);case 10:case 11:return(function(s,i){const o=s.mapValue.fields||{},a=i.mapValue.fields||{};if(So(o)!==So(a))return!1;for(const u in o)if(o.hasOwnProperty(u)&&(a[u]===void 0||!De(o[u],a[u])))return!1;return!0})(r,e);default:return A(52216,{left:r})}}function Zn(r,e){return(r.values||[]).find((t=>De(t,e)))!==void 0}function et(r,e){if(r===e)return 0;const t=Ze(r),n=Ze(e);if(t!==n)return P(t,n);switch(t){case 0:case 9007199254740991:return 0;case 1:return P(r.booleanValue,e.booleanValue);case 2:return(function(i,o){const a=G(i.integerValue||i.doubleValue),u=G(o.integerValue||o.doubleValue);return a<u?-1:a>u?1:a===u?0:isNaN(a)?isNaN(u)?0:-1:1})(r,e);case 3:return xo(r.timestampValue,e.timestampValue);case 4:return xo(Yn(r),Yn(e));case 5:return Ls(r.stringValue,e.stringValue);case 6:return(function(i,o){const a=Me(i),u=Me(o);return a.compareTo(u)})(r.bytesValue,e.bytesValue);case 7:return(function(i,o){const a=i.split("/"),u=o.split("/");for(let c=0;c<a.length&&c<u.length;c++){const l=P(a[c],u[c]);if(l!==0)return l}return P(a.length,u.length)})(r.referenceValue,e.referenceValue);case 8:return(function(i,o){const a=P(G(i.latitude),G(o.latitude));return a!==0?a:P(G(i.longitude),G(o.longitude))})(r.geoPointValue,e.geoPointValue);case 9:return Do(r.arrayValue,e.arrayValue);case 10:return(function(i,o){var d,_,y,I;const a=i.fields||{},u=o.fields||{},c=(d=a[on])==null?void 0:d.arrayValue,l=(_=u[on])==null?void 0:_.arrayValue,h=P(((y=c==null?void 0:c.values)==null?void 0:y.length)||0,((I=l==null?void 0:l.values)==null?void 0:I.length)||0);return h!==0?h:Do(c,l)})(r.mapValue,e.mapValue);case 11:return(function(i,o){if(i===We.mapValue&&o===We.mapValue)return 0;if(i===We.mapValue)return 1;if(o===We.mapValue)return-1;const a=i.fields||{},u=Object.keys(a),c=o.fields||{},l=Object.keys(c);u.sort(),l.sort();for(let h=0;h<u.length&&h<l.length;++h){const d=Ls(u[h],l[h]);if(d!==0)return d;const _=et(a[u[h]],c[l[h]]);if(_!==0)return _}return P(u.length,l.length)})(r.mapValue,e.mapValue);default:throw A(23264,{he:t})}}function xo(r,e){if(typeof r=="string"&&typeof e=="string"&&r.length===e.length)return P(r,e);const t=Fe(r),n=Fe(e),s=P(t.seconds,n.seconds);return s!==0?s:P(t.nanos,n.nanos)}function Do(r,e){const t=r.values||[],n=e.values||[];for(let s=0;s<t.length&&s<n.length;++s){const i=et(t[s],n[s]);if(i)return i}return P(t.length,n.length)}function an(r){return Ks(r)}function Ks(r){return"nullValue"in r?"null":"booleanValue"in r?""+r.booleanValue:"integerValue"in r?""+r.integerValue:"doubleValue"in r?""+r.doubleValue:"timestampValue"in r?(function(t){const n=Fe(t);return`time(${n.seconds},${n.nanos})`})(r.timestampValue):"stringValue"in r?r.stringValue:"bytesValue"in r?(function(t){return Me(t).toBase64()})(r.bytesValue):"referenceValue"in r?(function(t){return E.fromName(t).toString()})(r.referenceValue):"geoPointValue"in r?(function(t){return`geo(${t.latitude},${t.longitude})`})(r.geoPointValue):"arrayValue"in r?(function(t){let n="[",s=!0;for(const i of t.values||[])s?s=!1:n+=",",n+=Ks(i);return n+"]"})(r.arrayValue):"mapValue"in r?(function(t){const n=Object.keys(t.fields||{}).sort();let s="{",i=!0;for(const o of n)i?i=!1:s+=",",s+=`${o}:${Ks(t.fields[o])}`;return s+"}"})(r.mapValue):A(61005,{value:r})}function Dr(r){switch(Ze(r)){case 0:case 1:return 4;case 2:return 8;case 3:case 8:return 16;case 4:const e=as(r);return e?16+Dr(e):16;case 5:return 2*r.stringValue.length;case 6:return Me(r.bytesValue).approximateByteSize();case 7:return r.referenceValue.length;case 9:return(function(n){return(n.values||[]).reduce(((s,i)=>s+Dr(i)),0)})(r.arrayValue);case 10:case 11:return(function(n){let s=0;return at(n.fields,((i,o)=>{s+=i.length+Dr(o)})),s})(r.mapValue);default:throw A(13486,{value:r})}}function vt(r,e){return{referenceValue:`projects/${r.projectId}/databases/${r.database}/documents/${e.path.canonicalString()}`}}function Qs(r){return!!r&&"integerValue"in r}function er(r){return!!r&&"arrayValue"in r}function No(r){return!!r&&"nullValue"in r}function ko(r){return!!r&&"doubleValue"in r&&isNaN(Number(r.doubleValue))}function Nr(r){return!!r&&"mapValue"in r}function us(r){var t,n;return((n=(((t=r==null?void 0:r.mapValue)==null?void 0:t.fields)||{})[Ii])==null?void 0:n.stringValue)===Ti}function zn(r){if(r.geoPointValue)return{geoPointValue:{...r.geoPointValue}};if(r.timestampValue&&typeof r.timestampValue=="object")return{timestampValue:{...r.timestampValue}};if(r.mapValue){const e={mapValue:{fields:{}}};return at(r.mapValue.fields,((t,n)=>e.mapValue.fields[t]=zn(n))),e}if(r.arrayValue){const e={arrayValue:{values:[]}};for(let t=0;t<(r.arrayValue.values||[]).length;++t)e.arrayValue.values[t]=zn(r.arrayValue.values[t]);return e}return{...r}}function Ru(r){return(((r.mapValue||{}).fields||{}).__type__||{}).stringValue===vu}const Vu={mapValue:{fields:{[Ii]:{stringValue:Ti},[on]:{arrayValue:{}}}}};function Gh(r){return"nullValue"in r?xr:"booleanValue"in r?{booleanValue:!1}:"integerValue"in r||"doubleValue"in r?{doubleValue:NaN}:"timestampValue"in r?{timestampValue:{seconds:Number.MIN_SAFE_INTEGER}}:"stringValue"in r?{stringValue:""}:"bytesValue"in r?{bytesValue:""}:"referenceValue"in r?vt(At.empty(),E.empty()):"geoPointValue"in r?{geoPointValue:{latitude:-90,longitude:-180}}:"arrayValue"in r?{arrayValue:{}}:"mapValue"in r?us(r)?Vu:{mapValue:{}}:A(35942,{value:r})}function $h(r){return"nullValue"in r?{booleanValue:!1}:"booleanValue"in r?{doubleValue:NaN}:"integerValue"in r||"doubleValue"in r?{timestampValue:{seconds:Number.MIN_SAFE_INTEGER}}:"timestampValue"in r?{stringValue:""}:"stringValue"in r?{bytesValue:""}:"bytesValue"in r?vt(At.empty(),E.empty()):"referenceValue"in r?{geoPointValue:{latitude:-90,longitude:-180}}:"geoPointValue"in r?{arrayValue:{}}:"arrayValue"in r?Vu:"mapValue"in r?us(r)?{mapValue:{}}:We:A(61959,{value:r})}function Fo(r,e){const t=et(r.value,e.value);return t!==0?t:r.inclusive&&!e.inclusive?-1:!r.inclusive&&e.inclusive?1:0}function Mo(r,e){const t=et(r.value,e.value);return t!==0?t:r.inclusive&&!e.inclusive?1:!r.inclusive&&e.inclusive?-1:0}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class se{constructor(e){this.value=e}static empty(){return new se({mapValue:{}})}field(e){if(e.isEmpty())return this.value;{let t=this.value;for(let n=0;n<e.length-1;++n)if(t=(t.mapValue.fields||{})[e.get(n)],!Nr(t))return null;return t=(t.mapValue.fields||{})[e.lastSegment()],t||null}}set(e,t){this.getFieldsMap(e.popLast())[e.lastSegment()]=zn(t)}setAll(e){let t=$.emptyPath(),n={},s=[];e.forEach(((o,a)=>{if(!t.isImmediateParentOf(a)){const u=this.getFieldsMap(t);this.applyChanges(u,n,s),n={},s=[],t=a.popLast()}o?n[a.lastSegment()]=zn(o):s.push(a.lastSegment())}));const i=this.getFieldsMap(t);this.applyChanges(i,n,s)}delete(e){const t=this.field(e.popLast());Nr(t)&&t.mapValue.fields&&delete t.mapValue.fields[e.lastSegment()]}isEqual(e){return De(this.value,e.value)}getFieldsMap(e){let t=this.value;t.mapValue.fields||(t.mapValue={fields:{}});for(let n=0;n<e.length;++n){let s=t.mapValue.fields[e.get(n)];Nr(s)&&s.mapValue.fields||(s={mapValue:{fields:{}}},t.mapValue.fields[e.get(n)]=s),t=s}return t.mapValue.fields}applyChanges(e,t,n){at(t,((s,i)=>e[s]=i));for(const s of n)delete e[s]}clone(){return new se(zn(this.value))}}function Pu(r){const e=[];return at(r.fields,((t,n)=>{const s=new $([t]);if(Nr(n)){const i=Pu(n.mapValue).fields;if(i.length===0)e.push(s);else for(const o of i)e.push(s.child(o))}else e.push(s)})),new me(e)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class B{constructor(e,t,n,s,i,o,a){this.key=e,this.documentType=t,this.version=n,this.readTime=s,this.createTime=i,this.data=o,this.documentState=a}static newInvalidDocument(e){return new B(e,0,R.min(),R.min(),R.min(),se.empty(),0)}static newFoundDocument(e,t,n,s){return new B(e,1,t,R.min(),n,s,0)}static newNoDocument(e,t){return new B(e,2,t,R.min(),R.min(),se.empty(),0)}static newUnknownDocument(e,t){return new B(e,3,t,R.min(),R.min(),se.empty(),2)}convertToFoundDocument(e,t){return!this.createTime.isEqual(R.min())||this.documentType!==2&&this.documentType!==0||(this.createTime=e),this.version=e,this.documentType=1,this.data=t,this.documentState=0,this}convertToNoDocument(e){return this.version=e,this.documentType=2,this.data=se.empty(),this.documentState=0,this}convertToUnknownDocument(e){return this.version=e,this.documentType=3,this.data=se.empty(),this.documentState=2,this}setHasCommittedMutations(){return this.documentState=2,this}setHasLocalMutations(){return this.documentState=1,this.version=R.min(),this}setReadTime(e){return this.readTime=e,this}get hasLocalMutations(){return this.documentState===1}get hasCommittedMutations(){return this.documentState===2}get hasPendingWrites(){return this.hasLocalMutations||this.hasCommittedMutations}isValidDocument(){return this.documentType!==0}isFoundDocument(){return this.documentType===1}isNoDocument(){return this.documentType===2}isUnknownDocument(){return this.documentType===3}isEqual(e){return e instanceof B&&this.key.isEqual(e.key)&&this.version.isEqual(e.version)&&this.documentType===e.documentType&&this.documentState===e.documentState&&this.data.isEqual(e.data)}mutableCopy(){return new B(this.key,this.documentType,this.version,this.readTime,this.createTime,this.data.clone(),this.documentState)}toString(){return`Document(${this.key}, ${this.version}, ${JSON.stringify(this.data.value)}, {createTime: ${this.createTime}}), {documentType: ${this.documentType}}), {documentState: ${this.documentState}})`}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class tt{constructor(e,t){this.position=e,this.inclusive=t}}function Oo(r,e,t){let n=0;for(let s=0;s<r.position.length;s++){const i=e[s],o=r.position[s];if(i.field.isKeyField()?n=E.comparator(E.fromName(o.referenceValue),t.key):n=et(o,t.data.field(i.field)),i.dir==="desc"&&(n*=-1),n!==0)break}return n}function Lo(r,e){if(r===null)return e===null;if(e===null||r.inclusive!==e.inclusive||r.position.length!==e.position.length)return!1;for(let t=0;t<r.position.length;t++)if(!De(r.position[t],e.position[t]))return!1;return!0}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class tr{constructor(e,t="asc"){this.field=e,this.dir=t}}function Kh(r,e){return r.dir===e.dir&&r.field.isEqual(e.field)}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class bu{}class N extends bu{constructor(e,t,n){super(),this.field=e,this.op=t,this.value=n}static create(e,t,n){return e.isKeyField()?t==="in"||t==="not-in"?this.createKeyFieldInFilter(e,t,n):new Qh(e,t,n):t==="array-contains"?new Hh(e,n):t==="in"?new ku(e,n):t==="not-in"?new Jh(e,n):t==="array-contains-any"?new Yh(e,n):new N(e,t,n)}static createKeyFieldInFilter(e,t,n){return t==="in"?new jh(e,n):new Wh(e,n)}matches(e){const t=e.data.field(this.field);return this.op==="!="?t!==null&&t.nullValue===void 0&&this.matchesComparison(et(t,this.value)):t!==null&&Ze(this.value)===Ze(t)&&this.matchesComparison(et(t,this.value))}matchesComparison(e){switch(this.op){case"<":return e<0;case"<=":return e<=0;case"==":return e===0;case"!=":return e!==0;case">":return e>0;case">=":return e>=0;default:return A(47266,{operator:this.op})}}isInequality(){return["<","<=",">",">=","!=","not-in"].indexOf(this.op)>=0}getFlattenedFilters(){return[this]}getFilters(){return[this]}}class M extends bu{constructor(e,t){super(),this.filters=e,this.op=t,this.Pe=null}static create(e,t){return new M(e,t)}matches(e){return un(this)?this.filters.find((t=>!t.matches(e)))===void 0:this.filters.find((t=>t.matches(e)))!==void 0}getFlattenedFilters(){return this.Pe!==null||(this.Pe=this.filters.reduce(((e,t)=>e.concat(t.getFlattenedFilters())),[])),this.Pe}getFilters(){return Object.assign([],this.filters)}}function un(r){return r.op==="and"}function js(r){return r.op==="or"}function Ei(r){return Su(r)&&un(r)}function Su(r){for(const e of r.filters)if(e instanceof M)return!1;return!0}function Ws(r){if(r instanceof N)return r.field.canonicalString()+r.op.toString()+an(r.value);if(Ei(r))return r.filters.map((e=>Ws(e))).join(",");{const e=r.filters.map((t=>Ws(t))).join(",");return`${r.op}(${e})`}}function Cu(r,e){return r instanceof N?(function(n,s){return s instanceof N&&n.op===s.op&&n.field.isEqual(s.field)&&De(n.value,s.value)})(r,e):r instanceof M?(function(n,s){return s instanceof M&&n.op===s.op&&n.filters.length===s.filters.length?n.filters.reduce(((i,o,a)=>i&&Cu(o,s.filters[a])),!0):!1})(r,e):void A(19439)}function xu(r,e){const t=r.filters.concat(e);return M.create(t,r.op)}function Du(r){return r instanceof N?(function(t){return`${t.field.canonicalString()} ${t.op} ${an(t.value)}`})(r):r instanceof M?(function(t){return t.op.toString()+" {"+t.getFilters().map(Du).join(" ,")+"}"})(r):"Filter"}class Qh extends N{constructor(e,t,n){super(e,t,n),this.key=E.fromName(n.referenceValue)}matches(e){const t=E.comparator(e.key,this.key);return this.matchesComparison(t)}}class jh extends N{constructor(e,t){super(e,"in",t),this.keys=Nu("in",t)}matches(e){return this.keys.some((t=>t.isEqual(e.key)))}}class Wh extends N{constructor(e,t){super(e,"not-in",t),this.keys=Nu("not-in",t)}matches(e){return!this.keys.some((t=>t.isEqual(e.key)))}}function Nu(r,e){var t;return(((t=e.arrayValue)==null?void 0:t.values)||[]).map((n=>E.fromName(n.referenceValue)))}class Hh extends N{constructor(e,t){super(e,"array-contains",t)}matches(e){const t=e.data.field(this.field);return er(t)&&Zn(t.arrayValue,this.value)}}class ku extends N{constructor(e,t){super(e,"in",t)}matches(e){const t=e.data.field(this.field);return t!==null&&Zn(this.value.arrayValue,t)}}class Jh extends N{constructor(e,t){super(e,"not-in",t)}matches(e){if(Zn(this.value.arrayValue,{nullValue:"NULL_VALUE"}))return!1;const t=e.data.field(this.field);return t!==null&&t.nullValue===void 0&&!Zn(this.value.arrayValue,t)}}class Yh extends N{constructor(e,t){super(e,"array-contains-any",t)}matches(e){const t=e.data.field(this.field);return!(!er(t)||!t.arrayValue.values)&&t.arrayValue.values.some((n=>Zn(this.value.arrayValue,n)))}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Xh{constructor(e,t=null,n=[],s=[],i=null,o=null,a=null){this.path=e,this.collectionGroup=t,this.orderBy=n,this.filters=s,this.limit=i,this.startAt=o,this.endAt=a,this.Te=null}}function Hs(r,e=null,t=[],n=[],s=null,i=null,o=null){return new Xh(r,e,t,n,s,i,o)}function Rt(r){const e=w(r);if(e.Te===null){let t=e.path.canonicalString();e.collectionGroup!==null&&(t+="|cg:"+e.collectionGroup),t+="|f:",t+=e.filters.map((n=>Ws(n))).join(","),t+="|ob:",t+=e.orderBy.map((n=>(function(i){return i.field.canonicalString()+i.dir})(n))).join(","),ar(e.limit)||(t+="|l:",t+=e.limit),e.startAt&&(t+="|lb:",t+=e.startAt.inclusive?"b:":"a:",t+=e.startAt.position.map((n=>an(n))).join(",")),e.endAt&&(t+="|ub:",t+=e.endAt.inclusive?"a:":"b:",t+=e.endAt.position.map((n=>an(n))).join(",")),e.Te=t}return e.Te}function cr(r,e){if(r.limit!==e.limit||r.orderBy.length!==e.orderBy.length)return!1;for(let t=0;t<r.orderBy.length;t++)if(!Kh(r.orderBy[t],e.orderBy[t]))return!1;if(r.filters.length!==e.filters.length)return!1;for(let t=0;t<r.filters.length;t++)if(!Cu(r.filters[t],e.filters[t]))return!1;return r.collectionGroup===e.collectionGroup&&!!r.path.isEqual(e.path)&&!!Lo(r.startAt,e.startAt)&&Lo(r.endAt,e.endAt)}function Gr(r){return E.isDocumentKey(r.path)&&r.collectionGroup===null&&r.filters.length===0}function $r(r,e){return r.filters.filter((t=>t instanceof N&&t.field.isEqual(e)))}function qo(r,e,t){let n=xr,s=!0;for(const i of $r(r,e)){let o=xr,a=!0;switch(i.op){case"<":case"<=":o=Gh(i.value);break;case"==":case"in":case">=":o=i.value;break;case">":o=i.value,a=!1;break;case"!=":case"not-in":o=xr}Fo({value:n,inclusive:s},{value:o,inclusive:a})<0&&(n=o,s=a)}if(t!==null){for(let i=0;i<r.orderBy.length;++i)if(r.orderBy[i].field.isEqual(e)){const o=t.position[i];Fo({value:n,inclusive:s},{value:o,inclusive:t.inclusive})<0&&(n=o,s=t.inclusive);break}}return{value:n,inclusive:s}}function Uo(r,e,t){let n=We,s=!0;for(const i of $r(r,e)){let o=We,a=!0;switch(i.op){case">=":case">":o=$h(i.value),a=!1;break;case"==":case"in":case"<=":o=i.value;break;case"<":o=i.value,a=!1;break;case"!=":case"not-in":o=We}Mo({value:n,inclusive:s},{value:o,inclusive:a})>0&&(n=o,s=a)}if(t!==null){for(let i=0;i<r.orderBy.length;++i)if(r.orderBy[i].field.isEqual(e)){const o=t.position[i];Mo({value:n,inclusive:s},{value:o,inclusive:t.inclusive})>0&&(n=o,s=t.inclusive);break}}return{value:n,inclusive:s}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Le{constructor(e,t=null,n=[],s=[],i=null,o="F",a=null,u=null){this.path=e,this.collectionGroup=t,this.explicitOrderBy=n,this.filters=s,this.limit=i,this.limitType=o,this.startAt=a,this.endAt=u,this.Ie=null,this.Ee=null,this.Re=null,this.startAt,this.endAt}}function Fu(r,e,t,n,s,i,o,a){return new Le(r,e,t,n,s,i,o,a)}function In(r){return new Le(r)}function Bo(r){return r.filters.length===0&&r.limit===null&&r.startAt==null&&r.endAt==null&&(r.explicitOrderBy.length===0||r.explicitOrderBy.length===1&&r.explicitOrderBy[0].field.isKeyField())}function Zh(r){return E.isDocumentKey(r.path)&&r.collectionGroup===null&&r.filters.length===0}function wi(r){return r.collectionGroup!==null}function Wt(r){const e=w(r);if(e.Ie===null){e.Ie=[];const t=new Set;for(const i of e.explicitOrderBy)e.Ie.push(i),t.add(i.field.canonicalString());const n=e.explicitOrderBy.length>0?e.explicitOrderBy[e.explicitOrderBy.length-1].dir:"asc";(function(o){let a=new O($.comparator);return o.filters.forEach((u=>{u.getFlattenedFilters().forEach((c=>{c.isInequality()&&(a=a.add(c.field))}))})),a})(e).forEach((i=>{t.has(i.canonicalString())||i.isKeyField()||e.Ie.push(new tr(i,n))})),t.has($.keyField().canonicalString())||e.Ie.push(new tr($.keyField(),n))}return e.Ie}function he(r){const e=w(r);return e.Ee||(e.Ee=Ou(e,Wt(r))),e.Ee}function Mu(r){const e=w(r);return e.Re||(e.Re=Ou(e,r.explicitOrderBy)),e.Re}function Ou(r,e){if(r.limitType==="F")return Hs(r.path,r.collectionGroup,e,r.filters,r.limit,r.startAt,r.endAt);{e=e.map((s=>{const i=s.dir==="desc"?"asc":"desc";return new tr(s.field,i)}));const t=r.endAt?new tt(r.endAt.position,r.endAt.inclusive):null,n=r.startAt?new tt(r.startAt.position,r.startAt.inclusive):null;return Hs(r.path,r.collectionGroup,e,r.filters,r.limit,t,n)}}function Js(r,e){const t=r.filters.concat([e]);return new Le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),t,r.limit,r.limitType,r.startAt,r.endAt)}function ed(r,e){const t=r.explicitOrderBy.concat([e]);return new Le(r.path,r.collectionGroup,t,r.filters.slice(),r.limit,r.limitType,r.startAt,r.endAt)}function Kr(r,e,t){return new Le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),e,t,r.startAt,r.endAt)}function td(r,e){return new Le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),r.limit,r.limitType,e,r.endAt)}function nd(r,e){return new Le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),r.limit,r.limitType,r.startAt,e)}function lr(r,e){return cr(he(r),he(e))&&r.limitType===e.limitType}function Lu(r){return`${Rt(he(r))}|lt:${r.limitType}`}function Kt(r){return`Query(target=${(function(t){let n=t.path.canonicalString();return t.collectionGroup!==null&&(n+=" collectionGroup="+t.collectionGroup),t.filters.length>0&&(n+=`, filters: [${t.filters.map((s=>Du(s))).join(", ")}]`),ar(t.limit)||(n+=", limit: "+t.limit),t.orderBy.length>0&&(n+=`, orderBy: [${t.orderBy.map((s=>(function(o){return`${o.field.canonicalString()} (${o.dir})`})(s))).join(", ")}]`),t.startAt&&(n+=", startAt: ",n+=t.startAt.inclusive?"b:":"a:",n+=t.startAt.position.map((s=>an(s))).join(",")),t.endAt&&(n+=", endAt: ",n+=t.endAt.inclusive?"a:":"b:",n+=t.endAt.position.map((s=>an(s))).join(",")),`Target(${n})`})(he(r))}; limitType=${r.limitType})`}function hr(r,e){return e.isFoundDocument()&&(function(n,s){const i=s.key.path;return n.collectionGroup!==null?s.key.hasCollectionId(n.collectionGroup)&&n.path.isPrefixOf(i):E.isDocumentKey(n.path)?n.path.isEqual(i):n.path.isImmediateParentOf(i)})(r,e)&&(function(n,s){for(const i of Wt(n))if(!i.field.isKeyField()&&s.data.field(i.field)===null)return!1;return!0})(r,e)&&(function(n,s){for(const i of n.filters)if(!i.matches(s))return!1;return!0})(r,e)&&(function(n,s){return!(n.startAt&&!(function(o,a,u){const c=Oo(o,a,u);return o.inclusive?c<=0:c<0})(n.startAt,Wt(n),s)||n.endAt&&!(function(o,a,u){const c=Oo(o,a,u);return o.inclusive?c>=0:c>0})(n.endAt,Wt(n),s))})(r,e)}function qu(r){return r.collectionGroup||(r.path.length%2==1?r.path.lastSegment():r.path.get(r.path.length-2))}function Uu(r){return(e,t)=>{let n=!1;for(const s of Wt(r)){const i=rd(s,e,t);if(i!==0)return i;n=n||s.field.isKeyField()}return 0}}function rd(r,e,t){const n=r.field.isKeyField()?E.comparator(e.key,t.key):(function(i,o,a){const u=o.data.field(i),c=a.data.field(i);return u!==null&&c!==null?et(u,c):A(42886)})(r.field,e,t);switch(r.dir){case"asc":return n;case"desc":return-1*n;default:return A(19790,{direction:r.dir})}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class qe{constructor(e,t){this.mapKeyFn=e,this.equalsFn=t,this.inner={},this.innerSize=0}get(e){const t=this.mapKeyFn(e),n=this.inner[t];if(n!==void 0){for(const[s,i]of n)if(this.equalsFn(s,e))return i}}has(e){return this.get(e)!==void 0}set(e,t){const n=this.mapKeyFn(e),s=this.inner[n];if(s===void 0)return this.inner[n]=[[e,t]],void this.innerSize++;for(let i=0;i<s.length;i++)if(this.equalsFn(s[i][0],e))return void(s[i]=[e,t]);s.push([e,t]),this.innerSize++}delete(e){const t=this.mapKeyFn(e),n=this.inner[t];if(n===void 0)return!1;for(let s=0;s<n.length;s++)if(this.equalsFn(n[s][0],e))return n.length===1?delete this.inner[t]:n.splice(s,1),this.innerSize--,!0;return!1}forEach(e){at(this.inner,((t,n)=>{for(const[s,i]of n)e(s,i)}))}isEmpty(){return yu(this.inner)}size(){return this.innerSize}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const sd=new U(E.comparator);function _e(){return sd}const Bu=new U(E.comparator);function Fn(...r){let e=Bu;for(const t of r)e=e.insert(t.key,t);return e}function zu(r){let e=Bu;return r.forEach(((t,n)=>e=e.insert(t,n.overlayedDocument))),e}function Pe(){return Gn()}function Gu(){return Gn()}function Gn(){return new qe((r=>r.toString()),((r,e)=>r.isEqual(e)))}const id=new U(E.comparator),od=new O(E.comparator);function C(...r){let e=od;for(const t of r)e=e.add(t);return e}const ad=new O(P);function Ai(){return ad}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function vi(r,e){if(r.useProto3Json){if(isNaN(e))return{doubleValue:"NaN"};if(e===1/0)return{doubleValue:"Infinity"};if(e===-1/0)return{doubleValue:"-Infinity"}}return{doubleValue:jn(e)?"-0":e}}function $u(r){return{integerValue:""+r}}function Ku(r,e){return ou(e)?$u(e):vi(r,e)}/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class cs{constructor(){this._=void 0}}function ud(r,e,t){return r instanceof cn?(function(s,i){const o={fields:{[Eu]:{stringValue:Tu},[Au]:{timestampValue:{seconds:s.seconds,nanos:s.nanoseconds}}}};return i&&os(i)&&(i=as(i)),i&&(o.fields[wu]=i),{mapValue:o}})(t,e):r instanceof Vt?ju(r,e):r instanceof Pt?Wu(r,e):(function(s,i){const o=Qu(s,i),a=zo(o)+zo(s.Ae);return Qs(o)&&Qs(s.Ae)?$u(a):vi(s.serializer,a)})(r,e)}function cd(r,e,t){return r instanceof Vt?ju(r,e):r instanceof Pt?Wu(r,e):t}function Qu(r,e){return r instanceof ln?(function(n){return Qs(n)||(function(i){return!!i&&"doubleValue"in i})(n)})(e)?e:{integerValue:0}:null}class cn extends cs{}class Vt extends cs{constructor(e){super(),this.elements=e}}function ju(r,e){const t=Hu(e);for(const n of r.elements)t.some((s=>De(s,n)))||t.push(n);return{arrayValue:{values:t}}}class Pt extends cs{constructor(e){super(),this.elements=e}}function Wu(r,e){let t=Hu(e);for(const n of r.elements)t=t.filter((s=>!De(s,n)));return{arrayValue:{values:t}}}class ln extends cs{constructor(e,t){super(),this.serializer=e,this.Ae=t}}function zo(r){return G(r.integerValue||r.doubleValue)}function Hu(r){return er(r)&&r.arrayValue.values?r.arrayValue.values.slice():[]}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class dr{constructor(e,t){this.field=e,this.transform=t}}function ld(r,e){return r.field.isEqual(e.field)&&(function(n,s){return n instanceof Vt&&s instanceof Vt||n instanceof Pt&&s instanceof Pt?Yt(n.elements,s.elements,De):n instanceof ln&&s instanceof ln?De(n.Ae,s.Ae):n instanceof cn&&s instanceof cn})(r.transform,e.transform)}class hd{constructor(e,t){this.version=e,this.transformResults=t}}class K{constructor(e,t){this.updateTime=e,this.exists=t}static none(){return new K}static exists(e){return new K(void 0,e)}static updateTime(e){return new K(e)}get isNone(){return this.updateTime===void 0&&this.exists===void 0}isEqual(e){return this.exists===e.exists&&(this.updateTime?!!e.updateTime&&this.updateTime.isEqual(e.updateTime):!e.updateTime)}}function kr(r,e){return r.updateTime!==void 0?e.isFoundDocument()&&e.version.isEqual(r.updateTime):r.exists===void 0||r.exists===e.isFoundDocument()}class ls{}function Ju(r,e){if(!r.hasLocalMutations||e&&e.fields.length===0)return null;if(e===null)return r.isNoDocument()?new En(r.key,K.none()):new Tn(r.key,r.data,K.none());{const t=r.data,n=se.empty();let s=new O($.comparator);for(let i of e.fields)if(!s.has(i)){let o=t.field(i);o===null&&i.length>1&&(i=i.popLast(),o=t.field(i)),o===null?n.delete(i):n.set(i,o),s=s.add(i)}return new Ue(r.key,n,new me(s.toArray()),K.none())}}function dd(r,e,t){r instanceof Tn?(function(s,i,o){const a=s.value.clone(),u=$o(s.fieldTransforms,i,o.transformResults);a.setAll(u),i.convertToFoundDocument(o.version,a).setHasCommittedMutations()})(r,e,t):r instanceof Ue?(function(s,i,o){if(!kr(s.precondition,i))return void i.convertToUnknownDocument(o.version);const a=$o(s.fieldTransforms,i,o.transformResults),u=i.data;u.setAll(Yu(s)),u.setAll(a),i.convertToFoundDocument(o.version,u).setHasCommittedMutations()})(r,e,t):(function(s,i,o){i.convertToNoDocument(o.version).setHasCommittedMutations()})(0,e,t)}function $n(r,e,t,n){return r instanceof Tn?(function(i,o,a,u){if(!kr(i.precondition,o))return a;const c=i.value.clone(),l=Ko(i.fieldTransforms,u,o);return c.setAll(l),o.convertToFoundDocument(o.version,c).setHasLocalMutations(),null})(r,e,t,n):r instanceof Ue?(function(i,o,a,u){if(!kr(i.precondition,o))return a;const c=Ko(i.fieldTransforms,u,o),l=o.data;return l.setAll(Yu(i)),l.setAll(c),o.convertToFoundDocument(o.version,l).setHasLocalMutations(),a===null?null:a.unionWith(i.fieldMask.fields).unionWith(i.fieldTransforms.map((h=>h.field)))})(r,e,t,n):(function(i,o,a){return kr(i.precondition,o)?(o.convertToNoDocument(o.version).setHasLocalMutations(),null):a})(r,e,t)}function fd(r,e){let t=null;for(const n of r.fieldTransforms){const s=e.data.field(n.field),i=Qu(n.transform,s||null);i!=null&&(t===null&&(t=se.empty()),t.set(n.field,i))}return t||null}function Go(r,e){return r.type===e.type&&!!r.key.isEqual(e.key)&&!!r.precondition.isEqual(e.precondition)&&!!(function(n,s){return n===void 0&&s===void 0||!(!n||!s)&&Yt(n,s,((i,o)=>ld(i,o)))})(r.fieldTransforms,e.fieldTransforms)&&(r.type===0?r.value.isEqual(e.value):r.type!==1||r.data.isEqual(e.data)&&r.fieldMask.isEqual(e.fieldMask))}class Tn extends ls{constructor(e,t,n,s=[]){super(),this.key=e,this.value=t,this.precondition=n,this.fieldTransforms=s,this.type=0}getFieldMask(){return null}}class Ue extends ls{constructor(e,t,n,s,i=[]){super(),this.key=e,this.data=t,this.fieldMask=n,this.precondition=s,this.fieldTransforms=i,this.type=1}getFieldMask(){return this.fieldMask}}function Yu(r){const e=new Map;return r.fieldMask.fields.forEach((t=>{if(!t.isEmpty()){const n=r.data.field(t);e.set(t,n)}})),e}function $o(r,e,t){const n=new Map;v(r.length===t.length,32656,{Ve:t.length,de:r.length});for(let s=0;s<t.length;s++){const i=r[s],o=i.transform,a=e.data.field(i.field);n.set(i.field,cd(o,a,t[s]))}return n}function Ko(r,e,t){const n=new Map;for(const s of r){const i=s.transform,o=t.data.field(s.field);n.set(s.field,ud(i,o,e))}return n}class En extends ls{constructor(e,t){super(),this.key=e,this.precondition=t,this.type=2,this.fieldTransforms=[]}getFieldMask(){return null}}class Ri extends ls{constructor(e,t){super(),this.key=e,this.precondition=t,this.type=3,this.fieldTransforms=[]}getFieldMask(){return null}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Vi{constructor(e,t,n,s){this.batchId=e,this.localWriteTime=t,this.baseMutations=n,this.mutations=s}applyToRemoteDocument(e,t){const n=t.mutationResults;for(let s=0;s<this.mutations.length;s++){const i=this.mutations[s];i.key.isEqual(e.key)&&dd(i,e,n[s])}}applyToLocalView(e,t){for(const n of this.baseMutations)n.key.isEqual(e.key)&&(t=$n(n,e,t,this.localWriteTime));for(const n of this.mutations)n.key.isEqual(e.key)&&(t=$n(n,e,t,this.localWriteTime));return t}applyToLocalDocumentSet(e,t){const n=Gu();return this.mutations.forEach((s=>{const i=e.get(s.key),o=i.overlayedDocument;let a=this.applyToLocalView(o,i.mutatedFields);a=t.has(s.key)?null:a;const u=Ju(o,a);u!==null&&n.set(s.key,u),o.isValidDocument()||o.convertToNoDocument(R.min())})),n}keys(){return this.mutations.reduce(((e,t)=>e.add(t.key)),C())}isEqual(e){return this.batchId===e.batchId&&Yt(this.mutations,e.mutations,((t,n)=>Go(t,n)))&&Yt(this.baseMutations,e.baseMutations,((t,n)=>Go(t,n)))}}class Pi{constructor(e,t,n,s){this.batch=e,this.commitVersion=t,this.mutationResults=n,this.docVersions=s}static from(e,t,n){v(e.mutations.length===n.length,58842,{me:e.mutations.length,fe:n.length});let s=(function(){return id})();const i=e.mutations;for(let o=0;o<i.length;o++)s=s.insert(i[o].key,n[o].version);return new Pi(e,t,n,s)}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class bi{constructor(e,t){this.largestBatchId=e,this.mutation=t}getKey(){return this.mutation.key}isEqual(e){return e!==null&&this.mutation===e.mutation}toString(){return`Overlay{
      largestBatchId: ${this.largestBatchId},
      mutation: ${this.mutation.toString()}
    }`}}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Xu{constructor(e,t,n){this.alias=e,this.aggregateType=t,this.fieldPath=n}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class md{constructor(e,t){this.count=e,this.unchangedNames=t}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */var Y,k;function Zu(r){switch(r){case m.OK:return A(64938);case m.CANCELLED:case m.UNKNOWN:case m.DEADLINE_EXCEEDED:case m.RESOURCE_EXHAUSTED:case m.INTERNAL:case m.UNAVAILABLE:case m.UNAUTHENTICATED:return!1;case m.INVALID_ARGUMENT:case m.NOT_FOUND:case m.ALREADY_EXISTS:case m.PERMISSION_DENIED:case m.FAILED_PRECONDITION:case m.ABORTED:case m.OUT_OF_RANGE:case m.UNIMPLEMENTED:case m.DATA_LOSS:return!0;default:return A(15467,{code:r})}}function ec(r){if(r===void 0)return H("GRPC error has no .code"),m.UNKNOWN;switch(r){case Y.OK:return m.OK;case Y.CANCELLED:return m.CANCELLED;case Y.UNKNOWN:return m.UNKNOWN;case Y.DEADLINE_EXCEEDED:return m.DEADLINE_EXCEEDED;case Y.RESOURCE_EXHAUSTED:return m.RESOURCE_EXHAUSTED;case Y.INTERNAL:return m.INTERNAL;case Y.UNAVAILABLE:return m.UNAVAILABLE;case Y.UNAUTHENTICATED:return m.UNAUTHENTICATED;case Y.INVALID_ARGUMENT:return m.INVALID_ARGUMENT;case Y.NOT_FOUND:return m.NOT_FOUND;case Y.ALREADY_EXISTS:return m.ALREADY_EXISTS;case Y.PERMISSION_DENIED:return m.PERMISSION_DENIED;case Y.FAILED_PRECONDITION:return m.FAILED_PRECONDITION;case Y.ABORTED:return m.ABORTED;case Y.OUT_OF_RANGE:return m.OUT_OF_RANGE;case Y.UNIMPLEMENTED:return m.UNIMPLEMENTED;case Y.DATA_LOSS:return m.DATA_LOSS;default:return A(39323,{code:r})}}(k=Y||(Y={}))[k.OK=0]="OK",k[k.CANCELLED=1]="CANCELLED",k[k.UNKNOWN=2]="UNKNOWN",k[k.INVALID_ARGUMENT=3]="INVALID_ARGUMENT",k[k.DEADLINE_EXCEEDED=4]="DEADLINE_EXCEEDED",k[k.NOT_FOUND=5]="NOT_FOUND",k[k.ALREADY_EXISTS=6]="ALREADY_EXISTS",k[k.PERMISSION_DENIED=7]="PERMISSION_DENIED",k[k.UNAUTHENTICATED=16]="UNAUTHENTICATED",k[k.RESOURCE_EXHAUSTED=8]="RESOURCE_EXHAUSTED",k[k.FAILED_PRECONDITION=9]="FAILED_PRECONDITION",k[k.ABORTED=10]="ABORTED",k[k.OUT_OF_RANGE=11]="OUT_OF_RANGE",k[k.UNIMPLEMENTED=12]="UNIMPLEMENTED",k[k.INTERNAL=13]="INTERNAL",k[k.UNAVAILABLE=14]="UNAVAILABLE",k[k.DATA_LOSS=15]="DATA_LOSS";/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */let Kn=null;function _d(r){if(Kn)throw new Error("a TestingHooksSpi instance is already set");Kn=r}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function tc(){return new TextEncoder}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const gd=new It([4294967295,4294967295],0);function Qo(r){const e=tc().encode(r),t=new Kl;return t.update(e),new Uint8Array(t.digest())}function jo(r){const e=new DataView(r.buffer),t=e.getUint32(0,!0),n=e.getUint32(4,!0),s=e.getUint32(8,!0),i=e.getUint32(12,!0);return[new It([t,n],0),new It([s,i],0)]}class Si{constructor(e,t,n){if(this.bitmap=e,this.padding=t,this.hashCount=n,t<0||t>=8)throw new Mn(`Invalid padding: ${t}`);if(n<0)throw new Mn(`Invalid hash count: ${n}`);if(e.length>0&&this.hashCount===0)throw new Mn(`Invalid hash count: ${n}`);if(e.length===0&&t!==0)throw new Mn(`Invalid padding when bitmap length is 0: ${t}`);this.ge=8*e.length-t,this.pe=It.fromNumber(this.ge)}ye(e,t,n){let s=e.add(t.multiply(It.fromNumber(n)));return s.compare(gd)===1&&(s=new It([s.getBits(0),s.getBits(1)],0)),s.modulo(this.pe).toNumber()}we(e){return!!(this.bitmap[Math.floor(e/8)]&1<<e%8)}mightContain(e){if(this.ge===0)return!1;const t=Qo(e),[n,s]=jo(t);for(let i=0;i<this.hashCount;i++){const o=this.ye(n,s,i);if(!this.we(o))return!1}return!0}static create(e,t,n){const s=e%8==0?0:8-e%8,i=new Uint8Array(Math.ceil(e/8)),o=new Si(i,s,t);return n.forEach((a=>o.insert(a))),o}insert(e){if(this.ge===0)return;const t=Qo(e),[n,s]=jo(t);for(let i=0;i<this.hashCount;i++){const o=this.ye(n,s,i);this.be(o)}}be(e){const t=Math.floor(e/8),n=e%8;this.bitmap[t]|=1<<n}}class Mn extends Error{constructor(){super(...arguments),this.name="BloomFilterError"}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class fr{constructor(e,t,n,s,i){this.snapshotVersion=e,this.targetChanges=t,this.targetMismatches=n,this.documentUpdates=s,this.resolvedLimboDocuments=i}static createSynthesizedRemoteEventForCurrentChange(e,t,n){const s=new Map;return s.set(e,mr.createSynthesizedTargetChangeForCurrentChange(e,t,n)),new fr(R.min(),s,new U(P),_e(),C())}}class mr{constructor(e,t,n,s,i){this.resumeToken=e,this.current=t,this.addedDocuments=n,this.modifiedDocuments=s,this.removedDocuments=i}static createSynthesizedTargetChangeForCurrentChange(e,t,n){return new mr(n,t,C(),C(),C())}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Fr{constructor(e,t,n,s){this.Se=e,this.removedTargetIds=t,this.key=n,this.De=s}}class nc{constructor(e,t){this.targetId=e,this.Ce=t}}class rc{constructor(e,t,n=W.EMPTY_BYTE_STRING,s=null){this.state=e,this.targetIds=t,this.resumeToken=n,this.cause=s}}class Wo{constructor(){this.ve=0,this.Fe=Ho(),this.Me=W.EMPTY_BYTE_STRING,this.xe=!1,this.Oe=!0}get current(){return this.xe}get resumeToken(){return this.Me}get Ne(){return this.ve!==0}get Be(){return this.Oe}Le(e){e.approximateByteSize()>0&&(this.Oe=!0,this.Me=e)}ke(){let e=C(),t=C(),n=C();return this.Fe.forEach(((s,i)=>{switch(i){case 0:e=e.add(s);break;case 2:t=t.add(s);break;case 1:n=n.add(s);break;default:A(38017,{changeType:i})}})),new mr(this.Me,this.xe,e,t,n)}Ke(){this.Oe=!1,this.Fe=Ho()}qe(e,t){this.Oe=!0,this.Fe=this.Fe.insert(e,t)}Ue(e){this.Oe=!0,this.Fe=this.Fe.remove(e)}$e(){this.ve+=1}We(){this.ve-=1,v(this.ve>=0,3241,{ve:this.ve})}Qe(){this.Oe=!0,this.xe=!0}}class pd{constructor(e){this.Ge=e,this.ze=new Map,this.je=_e(),this.He=Ar(),this.Je=Ar(),this.Ze=new U(P)}Xe(e){for(const t of e.Se)e.De&&e.De.isFoundDocument()?this.Ye(t,e.De):this.et(t,e.key,e.De);for(const t of e.removedTargetIds)this.et(t,e.key,e.De)}tt(e){this.forEachTarget(e,(t=>{const n=this.nt(t);switch(e.state){case 0:this.rt(t)&&n.Le(e.resumeToken);break;case 1:n.We(),n.Ne||n.Ke(),n.Le(e.resumeToken);break;case 2:n.We(),n.Ne||this.removeTarget(t);break;case 3:this.rt(t)&&(n.Qe(),n.Le(e.resumeToken));break;case 4:this.rt(t)&&(this.it(t),n.Le(e.resumeToken));break;default:A(56790,{state:e.state})}}))}forEachTarget(e,t){e.targetIds.length>0?e.targetIds.forEach(t):this.ze.forEach(((n,s)=>{this.rt(s)&&t(s)}))}st(e){const t=e.targetId,n=e.Ce.count,s=this.ot(t);if(s){const i=s.target;if(Gr(i))if(n===0){const o=new E(i.path);this.et(t,o,B.newNoDocument(o,R.min()))}else v(n===1,20013,{expectedCount:n});else{const o=this._t(t);if(o!==n){const a=this.ut(e),u=a?this.ct(a,e,o):1;if(u!==0){this.it(t);const c=u===2?"TargetPurposeExistenceFilterMismatchBloom":"TargetPurposeExistenceFilterMismatch";this.Ze=this.Ze.insert(t,c)}Kn==null||Kn.lt((function(l,h,d,_,y){var V,S,b;const I={localCacheCount:l,existenceFilterCount:h.count,databaseId:d.database,projectId:d.projectId},T=h.unchangedNames;return T&&(I.bloomFilter={applied:y===0,hashCount:(T==null?void 0:T.hashCount)??0,bitmapLength:((S=(V=T==null?void 0:T.bits)==null?void 0:V.bitmap)==null?void 0:S.length)??0,padding:((b=T==null?void 0:T.bits)==null?void 0:b.padding)??0,mightContain:Q=>(_==null?void 0:_.mightContain(Q))??!1}),I})(o,e.Ce,this.Ge.ht(),a,u))}}}}ut(e){const t=e.Ce.unchangedNames;if(!t||!t.bits)return null;const{bits:{bitmap:n="",padding:s=0},hashCount:i=0}=t;let o,a;try{o=Me(n).toUint8Array()}catch(u){if(u instanceof Iu)return Te("Decoding the base64 bloom filter in existence filter failed ("+u.message+"); ignoring the bloom filter and falling back to full re-query."),null;throw u}try{a=new Si(o,s,i)}catch(u){return Te(u instanceof Mn?"BloomFilter error: ":"Applying bloom filter failed: ",u),null}return a.ge===0?null:a}ct(e,t,n){return t.Ce.count===n-this.Pt(e,t.targetId)?0:2}Pt(e,t){const n=this.Ge.getRemoteKeysForTarget(t);let s=0;return n.forEach((i=>{const o=this.Ge.ht(),a=`projects/${o.projectId}/databases/${o.database}/documents/${i.path.canonicalString()}`;e.mightContain(a)||(this.et(t,i,null),s++)})),s}Tt(e){const t=new Map;this.ze.forEach(((i,o)=>{const a=this.ot(o);if(a){if(i.current&&Gr(a.target)){const u=new E(a.target.path);this.It(u).has(o)||this.Et(o,u)||this.et(o,u,B.newNoDocument(u,e))}i.Be&&(t.set(o,i.ke()),i.Ke())}}));let n=C();this.Je.forEach(((i,o)=>{let a=!0;o.forEachWhile((u=>{const c=this.ot(u);return!c||c.purpose==="TargetPurposeLimboResolution"||(a=!1,!1)})),a&&(n=n.add(i))})),this.je.forEach(((i,o)=>o.setReadTime(e)));const s=new fr(e,t,this.Ze,this.je,n);return this.je=_e(),this.He=Ar(),this.Je=Ar(),this.Ze=new U(P),s}Ye(e,t){if(!this.rt(e))return;const n=this.Et(e,t.key)?2:0;this.nt(e).qe(t.key,n),this.je=this.je.insert(t.key,t),this.He=this.He.insert(t.key,this.It(t.key).add(e)),this.Je=this.Je.insert(t.key,this.Rt(t.key).add(e))}et(e,t,n){if(!this.rt(e))return;const s=this.nt(e);this.Et(e,t)?s.qe(t,1):s.Ue(t),this.Je=this.Je.insert(t,this.Rt(t).delete(e)),this.Je=this.Je.insert(t,this.Rt(t).add(e)),n&&(this.je=this.je.insert(t,n))}removeTarget(e){this.ze.delete(e)}_t(e){const t=this.nt(e).ke();return this.Ge.getRemoteKeysForTarget(e).size+t.addedDocuments.size-t.removedDocuments.size}$e(e){this.nt(e).$e()}nt(e){let t=this.ze.get(e);return t||(t=new Wo,this.ze.set(e,t)),t}Rt(e){let t=this.Je.get(e);return t||(t=new O(P),this.Je=this.Je.insert(e,t)),t}It(e){let t=this.He.get(e);return t||(t=new O(P),this.He=this.He.insert(e,t)),t}rt(e){const t=this.ot(e)!==null;return t||p("WatchChangeAggregator","Detected inactive target",e),t}ot(e){const t=this.ze.get(e);return t&&t.Ne?null:this.Ge.At(e)}it(e){this.ze.set(e,new Wo),this.Ge.getRemoteKeysForTarget(e).forEach((t=>{this.et(e,t,null)}))}Et(e,t){return this.Ge.getRemoteKeysForTarget(e).has(t)}}function Ar(){return new U(E.comparator)}function Ho(){return new U(E.comparator)}const yd={asc:"ASCENDING",desc:"DESCENDING"},Id={"<":"LESS_THAN","<=":"LESS_THAN_OR_EQUAL",">":"GREATER_THAN",">=":"GREATER_THAN_OR_EQUAL","==":"EQUAL","!=":"NOT_EQUAL","array-contains":"ARRAY_CONTAINS",in:"IN","not-in":"NOT_IN","array-contains-any":"ARRAY_CONTAINS_ANY"},Td={and:"AND",or:"OR"};class Ed{constructor(e,t){this.databaseId=e,this.useProto3Json=t}}function Ys(r,e){return r.useProto3Json||ar(e)?e:{value:e}}function hn(r,e){return r.useProto3Json?`${new Date(1e3*e.seconds).toISOString().replace(/\.\d*/,"").replace("Z","")}.${("000000000"+e.nanoseconds).slice(-9)}Z`:{seconds:""+e.seconds,nanos:e.nanoseconds}}function sc(r,e){return r.useProto3Json?e.toBase64():e.toUint8Array()}function wd(r,e){return hn(r,e.toTimestamp())}function J(r){return v(!!r,49232),R.fromTimestamp((function(t){const n=Fe(t);return new F(n.seconds,n.nanos)})(r))}function Ci(r,e){return Xs(r,e).canonicalString()}function Xs(r,e){const t=(function(s){return new x(["projects",s.projectId,"databases",s.database])})(r).child("documents");return e===void 0?t:t.child(e)}function ic(r){const e=x.fromString(r);return v(mc(e),10190,{key:e.toString()}),e}function nr(r,e){return Ci(r.databaseId,e.path)}function Se(r,e){const t=ic(e);if(t.get(1)!==r.databaseId.projectId)throw new g(m.INVALID_ARGUMENT,"Tried to deserialize key from different project: "+t.get(1)+" vs "+r.databaseId.projectId);if(t.get(3)!==r.databaseId.database)throw new g(m.INVALID_ARGUMENT,"Tried to deserialize key from different database: "+t.get(3)+" vs "+r.databaseId.database);return new E(uc(t))}function oc(r,e){return Ci(r.databaseId,e)}function ac(r){const e=ic(r);return e.length===4?x.emptyPath():uc(e)}function Zs(r){return new x(["projects",r.databaseId.projectId,"databases",r.databaseId.database]).canonicalString()}function uc(r){return v(r.length>4&&r.get(4)==="documents",29091,{key:r.toString()}),r.popFirst(5)}function Jo(r,e,t){return{name:nr(r,e),fields:t.value.mapValue.fields}}function hs(r,e,t){const n=Se(r,e.name),s=J(e.updateTime),i=e.createTime?J(e.createTime):R.min(),o=new se({mapValue:{fields:e.fields}}),a=B.newFoundDocument(n,s,i,o);return t&&a.setHasCommittedMutations(),t?a.setHasCommittedMutations():a}function Ad(r,e){return"found"in e?(function(n,s){v(!!s.found,43571),s.found.name,s.found.updateTime;const i=Se(n,s.found.name),o=J(s.found.updateTime),a=s.found.createTime?J(s.found.createTime):R.min(),u=new se({mapValue:{fields:s.found.fields}});return B.newFoundDocument(i,o,a,u)})(r,e):"missing"in e?(function(n,s){v(!!s.missing,3894),v(!!s.readTime,22933);const i=Se(n,s.missing),o=J(s.readTime);return B.newNoDocument(i,o)})(r,e):A(7234,{result:e})}function vd(r,e){let t;if("targetChange"in e){e.targetChange;const n=(function(c){return c==="NO_CHANGE"?0:c==="ADD"?1:c==="REMOVE"?2:c==="CURRENT"?3:c==="RESET"?4:A(39313,{state:c})})(e.targetChange.targetChangeType||"NO_CHANGE"),s=e.targetChange.targetIds||[],i=(function(c,l){return c.useProto3Json?(v(l===void 0||typeof l=="string",58123),W.fromBase64String(l||"")):(v(l===void 0||l instanceof Buffer||l instanceof Uint8Array,16193),W.fromUint8Array(l||new Uint8Array))})(r,e.targetChange.resumeToken),o=e.targetChange.cause,a=o&&(function(c){const l=c.code===void 0?m.UNKNOWN:ec(c.code);return new g(l,c.message||"")})(o);t=new rc(n,s,i,a||null)}else if("documentChange"in e){e.documentChange;const n=e.documentChange;n.document,n.document.name,n.document.updateTime;const s=Se(r,n.document.name),i=J(n.document.updateTime),o=n.document.createTime?J(n.document.createTime):R.min(),a=new se({mapValue:{fields:n.document.fields}}),u=B.newFoundDocument(s,i,o,a),c=n.targetIds||[],l=n.removedTargetIds||[];t=new Fr(c,l,u.key,u)}else if("documentDelete"in e){e.documentDelete;const n=e.documentDelete;n.document;const s=Se(r,n.document),i=n.readTime?J(n.readTime):R.min(),o=B.newNoDocument(s,i),a=n.removedTargetIds||[];t=new Fr([],a,o.key,o)}else if("documentRemove"in e){e.documentRemove;const n=e.documentRemove;n.document;const s=Se(r,n.document),i=n.removedTargetIds||[];t=new Fr([],i,s,null)}else{if(!("filter"in e))return A(11601,{Vt:e});{e.filter;const n=e.filter;n.targetId;const{count:s=0,unchangedNames:i}=n,o=new md(s,i),a=n.targetId;t=new nc(a,o)}}return t}function rr(r,e){let t;if(e instanceof Tn)t={update:Jo(r,e.key,e.value)};else if(e instanceof En)t={delete:nr(r,e.key)};else if(e instanceof Ue)t={update:Jo(r,e.key,e.data),updateMask:Cd(e.fieldMask)};else{if(!(e instanceof Ri))return A(16599,{dt:e.type});t={verify:nr(r,e.key)}}return e.fieldTransforms.length>0&&(t.updateTransforms=e.fieldTransforms.map((n=>(function(i,o){const a=o.transform;if(a instanceof cn)return{fieldPath:o.field.canonicalString(),setToServerValue:"REQUEST_TIME"};if(a instanceof Vt)return{fieldPath:o.field.canonicalString(),appendMissingElements:{values:a.elements}};if(a instanceof Pt)return{fieldPath:o.field.canonicalString(),removeAllFromArray:{values:a.elements}};if(a instanceof ln)return{fieldPath:o.field.canonicalString(),increment:a.Ae};throw A(20930,{transform:o.transform})})(0,n)))),e.precondition.isNone||(t.currentDocument=(function(s,i){return i.updateTime!==void 0?{updateTime:wd(s,i.updateTime)}:i.exists!==void 0?{exists:i.exists}:A(27497)})(r,e.precondition)),t}function ei(r,e){const t=e.currentDocument?(function(i){return i.updateTime!==void 0?K.updateTime(J(i.updateTime)):i.exists!==void 0?K.exists(i.exists):K.none()})(e.currentDocument):K.none(),n=e.updateTransforms?e.updateTransforms.map((s=>(function(o,a){let u=null;if("setToServerValue"in a)v(a.setToServerValue==="REQUEST_TIME",16630,{proto:a}),u=new cn;else if("appendMissingElements"in a){const l=a.appendMissingElements.values||[];u=new Vt(l)}else if("removeAllFromArray"in a){const l=a.removeAllFromArray.values||[];u=new Pt(l)}else"increment"in a?u=new ln(o,a.increment):A(16584,{proto:a});const c=$.fromServerFormat(a.fieldPath);return new dr(c,u)})(r,s))):[];if(e.update){e.update.name;const s=Se(r,e.update.name),i=new se({mapValue:{fields:e.update.fields}});if(e.updateMask){const o=(function(u){const c=u.fieldPaths||[];return new me(c.map((l=>$.fromServerFormat(l))))})(e.updateMask);return new Ue(s,i,o,t,n)}return new Tn(s,i,t,n)}if(e.delete){const s=Se(r,e.delete);return new En(s,t)}if(e.verify){const s=Se(r,e.verify);return new Ri(s,t)}return A(1463,{proto:e})}function Rd(r,e){return r&&r.length>0?(v(e!==void 0,14353),r.map((t=>(function(s,i){let o=s.updateTime?J(s.updateTime):J(i);return o.isEqual(R.min())&&(o=J(i)),new hd(o,s.transformResults||[])})(t,e)))):[]}function cc(r,e){return{documents:[oc(r,e.path)]}}function ds(r,e){const t={structuredQuery:{}},n=e.path;let s;e.collectionGroup!==null?(s=n,t.structuredQuery.from=[{collectionId:e.collectionGroup,allDescendants:!0}]):(s=n.popLast(),t.structuredQuery.from=[{collectionId:n.lastSegment()}]),t.parent=oc(r,s);const i=(function(c){if(c.length!==0)return fc(M.create(c,"and"))})(e.filters);i&&(t.structuredQuery.where=i);const o=(function(c){if(c.length!==0)return c.map((l=>(function(d){return{field:Qe(d.field),direction:Pd(d.dir)}})(l)))})(e.orderBy);o&&(t.structuredQuery.orderBy=o);const a=Ys(r,e.limit);return a!==null&&(t.structuredQuery.limit=a),e.startAt&&(t.structuredQuery.startAt=(function(c){return{before:c.inclusive,values:c.position}})(e.startAt)),e.endAt&&(t.structuredQuery.endAt=(function(c){return{before:!c.inclusive,values:c.position}})(e.endAt)),{ft:t,parent:s}}function lc(r,e,t,n){const{ft:s,parent:i}=ds(r,e),o={},a=[];let u=0;return t.forEach((c=>{const l=n?c.alias:"aggregate_"+u++;o[l]=c.alias,c.aggregateType==="count"?a.push({alias:l,count:{}}):c.aggregateType==="avg"?a.push({alias:l,avg:{field:Qe(c.fieldPath)}}):c.aggregateType==="sum"&&a.push({alias:l,sum:{field:Qe(c.fieldPath)}})})),{request:{structuredAggregationQuery:{aggregations:a,structuredQuery:s.structuredQuery},parent:s.parent},gt:o,parent:i}}function hc(r){let e=ac(r.parent);const t=r.structuredQuery,n=t.from?t.from.length:0;let s=null;if(n>0){v(n===1,65062);const l=t.from[0];l.allDescendants?s=l.collectionId:e=e.child(l.collectionId)}let i=[];t.where&&(i=(function(h){const d=dc(h);return d instanceof M&&Ei(d)?d.getFilters():[d]})(t.where));let o=[];t.orderBy&&(o=(function(h){return h.map((d=>(function(y){return new tr(Qt(y.field),(function(T){switch(T){case"ASCENDING":return"asc";case"DESCENDING":return"desc";default:return}})(y.direction))})(d)))})(t.orderBy));let a=null;t.limit&&(a=(function(h){let d;return d=typeof h=="object"?h.value:h,ar(d)?null:d})(t.limit));let u=null;t.startAt&&(u=(function(h){const d=!!h.before,_=h.values||[];return new tt(_,d)})(t.startAt));let c=null;return t.endAt&&(c=(function(h){const d=!h.before,_=h.values||[];return new tt(_,d)})(t.endAt)),Fu(e,s,o,i,a,"F",u,c)}function Vd(r,e){const t=(function(s){switch(s){case"TargetPurposeListen":return null;case"TargetPurposeExistenceFilterMismatch":return"existence-filter-mismatch";case"TargetPurposeExistenceFilterMismatchBloom":return"existence-filter-mismatch-bloom";case"TargetPurposeLimboResolution":return"limbo-document";default:return A(28987,{purpose:s})}})(e.purpose);return t==null?null:{"goog-listen-tags":t}}function dc(r){return r.unaryFilter!==void 0?(function(t){switch(t.unaryFilter.op){case"IS_NAN":const n=Qt(t.unaryFilter.field);return N.create(n,"==",{doubleValue:NaN});case"IS_NULL":const s=Qt(t.unaryFilter.field);return N.create(s,"==",{nullValue:"NULL_VALUE"});case"IS_NOT_NAN":const i=Qt(t.unaryFilter.field);return N.create(i,"!=",{doubleValue:NaN});case"IS_NOT_NULL":const o=Qt(t.unaryFilter.field);return N.create(o,"!=",{nullValue:"NULL_VALUE"});case"OPERATOR_UNSPECIFIED":return A(61313);default:return A(60726)}})(r):r.fieldFilter!==void 0?(function(t){return N.create(Qt(t.fieldFilter.field),(function(s){switch(s){case"EQUAL":return"==";case"NOT_EQUAL":return"!=";case"GREATER_THAN":return">";case"GREATER_THAN_OR_EQUAL":return">=";case"LESS_THAN":return"<";case"LESS_THAN_OR_EQUAL":return"<=";case"ARRAY_CONTAINS":return"array-contains";case"IN":return"in";case"NOT_IN":return"not-in";case"ARRAY_CONTAINS_ANY":return"array-contains-any";case"OPERATOR_UNSPECIFIED":return A(58110);default:return A(50506)}})(t.fieldFilter.op),t.fieldFilter.value)})(r):r.compositeFilter!==void 0?(function(t){return M.create(t.compositeFilter.filters.map((n=>dc(n))),(function(s){switch(s){case"AND":return"and";case"OR":return"or";default:return A(1026)}})(t.compositeFilter.op))})(r):A(30097,{filter:r})}function Pd(r){return yd[r]}function bd(r){return Id[r]}function Sd(r){return Td[r]}function Qe(r){return{fieldPath:r.canonicalString()}}function Qt(r){return $.fromServerFormat(r.fieldPath)}function fc(r){return r instanceof N?(function(t){if(t.op==="=="){if(ko(t.value))return{unaryFilter:{field:Qe(t.field),op:"IS_NAN"}};if(No(t.value))return{unaryFilter:{field:Qe(t.field),op:"IS_NULL"}}}else if(t.op==="!="){if(ko(t.value))return{unaryFilter:{field:Qe(t.field),op:"IS_NOT_NAN"}};if(No(t.value))return{unaryFilter:{field:Qe(t.field),op:"IS_NOT_NULL"}}}return{fieldFilter:{field:Qe(t.field),op:bd(t.op),value:t.value}}})(r):r instanceof M?(function(t){const n=t.getFilters().map((s=>fc(s)));return n.length===1?n[0]:{compositeFilter:{op:Sd(t.op),filters:n}}})(r):A(54877,{filter:r})}function Cd(r){const e=[];return r.fields.forEach((t=>e.push(t.canonicalString()))),{fieldPaths:e}}function mc(r){return r.length>=4&&r.get(0)==="projects"&&r.get(2)==="databases"}function _c(r){return!!r&&typeof r._toProto=="function"&&r._protoValueType==="ProtoValue"}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ke{constructor(e,t,n,s,i=R.min(),o=R.min(),a=W.EMPTY_BYTE_STRING,u=null){this.target=e,this.targetId=t,this.purpose=n,this.sequenceNumber=s,this.snapshotVersion=i,this.lastLimboFreeSnapshotVersion=o,this.resumeToken=a,this.expectedCount=u}withSequenceNumber(e){return new ke(this.target,this.targetId,this.purpose,e,this.snapshotVersion,this.lastLimboFreeSnapshotVersion,this.resumeToken,this.expectedCount)}withResumeToken(e,t){return new ke(this.target,this.targetId,this.purpose,this.sequenceNumber,t,this.lastLimboFreeSnapshotVersion,e,null)}withExpectedCount(e){return new ke(this.target,this.targetId,this.purpose,this.sequenceNumber,this.snapshotVersion,this.lastLimboFreeSnapshotVersion,this.resumeToken,e)}withLastLimboFreeSnapshotVersion(e){return new ke(this.target,this.targetId,this.purpose,this.sequenceNumber,this.snapshotVersion,e,this.resumeToken,this.expectedCount)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class gc{constructor(e){this.yt=e}}function xd(r,e){let t;if(e.document)t=hs(r.yt,e.document,!!e.hasCommittedMutations);else if(e.noDocument){const n=E.fromSegments(e.noDocument.path),s=St(e.noDocument.readTime);t=B.newNoDocument(n,s),e.hasCommittedMutations&&t.setHasCommittedMutations()}else{if(!e.unknownDocument)return A(56709);{const n=E.fromSegments(e.unknownDocument.path),s=St(e.unknownDocument.version);t=B.newUnknownDocument(n,s)}}return e.readTime&&t.setReadTime((function(s){const i=new F(s[0],s[1]);return R.fromTimestamp(i)})(e.readTime)),t}function Yo(r,e){const t=e.key,n={prefixPath:t.getCollectionPath().popLast().toArray(),collectionGroup:t.collectionGroup,documentId:t.path.lastSegment(),readTime:Qr(e.readTime),hasCommittedMutations:e.hasCommittedMutations};if(e.isFoundDocument())n.document=(function(i,o){return{name:nr(i,o.key),fields:o.data.value.mapValue.fields,updateTime:hn(i,o.version.toTimestamp()),createTime:hn(i,o.createTime.toTimestamp())}})(r.yt,e);else if(e.isNoDocument())n.noDocument={path:t.path.toArray(),readTime:bt(e.version)};else{if(!e.isUnknownDocument())return A(57904,{document:e});n.unknownDocument={path:t.path.toArray(),version:bt(e.version)}}return n}function Qr(r){const e=r.toTimestamp();return[e.seconds,e.nanoseconds]}function bt(r){const e=r.toTimestamp();return{seconds:e.seconds,nanoseconds:e.nanoseconds}}function St(r){const e=new F(r.seconds,r.nanoseconds);return R.fromTimestamp(e)}function _t(r,e){const t=(e.baseMutations||[]).map((i=>ei(r.yt,i)));for(let i=0;i<e.mutations.length-1;++i){const o=e.mutations[i];if(i+1<e.mutations.length&&e.mutations[i+1].transform!==void 0){const a=e.mutations[i+1];o.updateTransforms=a.transform.fieldTransforms,e.mutations.splice(i+1,1),++i}}const n=e.mutations.map((i=>ei(r.yt,i))),s=F.fromMillis(e.localWriteTimeMs);return new Vi(e.batchId,s,t,n)}function On(r){const e=St(r.readTime),t=r.lastLimboFreeSnapshotVersion!==void 0?St(r.lastLimboFreeSnapshotVersion):R.min();let n;return n=(function(i){return i.documents!==void 0})(r.query)?(function(i){const o=i.documents.length;return v(o===1,1966,{count:o}),he(In(ac(i.documents[0])))})(r.query):(function(i){return he(hc(i))})(r.query),new ke(n,r.targetId,"TargetPurposeListen",r.lastListenSequenceNumber,e,t,W.fromBase64String(r.resumeToken))}function pc(r,e){const t=bt(e.snapshotVersion),n=bt(e.lastLimboFreeSnapshotVersion);let s;s=Gr(e.target)?cc(r.yt,e.target):ds(r.yt,e.target).ft;const i=e.resumeToken.toBase64();return{targetId:e.targetId,canonicalId:Rt(e.target),readTime:t,resumeToken:i,lastListenSequenceNumber:e.sequenceNumber,lastLimboFreeSnapshotVersion:n,query:s}}function fs(r){const e=hc({parent:r.parent,structuredQuery:r.structuredQuery});return r.limitType==="LAST"?Kr(e,e.limit,"L"):e}function Ss(r,e){return new bi(e.largestBatchId,ei(r.yt,e.overlayMutation))}function Xo(r,e){const t=e.path.lastSegment();return[r,le(e.path.popLast()),t]}function Zo(r,e,t,n){return{indexId:r,uid:e,sequenceNumber:t,readTime:bt(n.readTime),documentKey:le(n.documentKey.path),largestBatchId:n.largestBatchId}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Dd{getBundleMetadata(e,t){return ea(e).get(t).next((n=>{if(n)return(function(i){return{id:i.bundleId,createTime:St(i.createTime),version:i.version}})(n)}))}saveBundleMetadata(e,t){return ea(e).put((function(s){return{bundleId:s.id,createTime:bt(J(s.createTime)),version:s.version}})(t))}getNamedQuery(e,t){return ta(e).get(t).next((n=>{if(n)return(function(i){return{name:i.name,query:fs(i.bundledQuery),readTime:St(i.readTime)}})(n)}))}saveNamedQuery(e,t){return ta(e).put((function(s){return{name:s.name,readTime:bt(J(s.readTime)),bundledQuery:s.bundledQuery}})(t))}}function ea(r){return te(r,rs)}function ta(r){return te(r,ss)}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ms{constructor(e,t){this.serializer=e,this.userId=t}static wt(e,t){const n=t.uid||"";return new ms(e,n)}getOverlay(e,t){return Sn(e).get(Xo(this.userId,t)).next((n=>n?Ss(this.serializer,n):null))}getOverlays(e,t){const n=Pe();return f.forEach(t,(s=>this.getOverlay(e,s).next((i=>{i!==null&&n.set(s,i)})))).next((()=>n))}saveOverlays(e,t,n){const s=[];return n.forEach(((i,o)=>{const a=new bi(t,o);s.push(this.bt(e,a))})),f.waitFor(s)}removeOverlaysForBatchId(e,t,n){const s=new Set;t.forEach((o=>s.add(le(o.getCollectionPath()))));const i=[];return s.forEach((o=>{const a=IDBKeyRange.bound([this.userId,o,n],[this.userId,o,n+1],!1,!0);i.push(Sn(e).X(Gs,a))})),f.waitFor(i)}getOverlaysForCollection(e,t,n){const s=Pe(),i=le(t),o=IDBKeyRange.bound([this.userId,i,n],[this.userId,i,Number.POSITIVE_INFINITY],!0);return Sn(e).H(Gs,o).next((a=>{for(const u of a){const c=Ss(this.serializer,u);s.set(c.getKey(),c)}return s}))}getOverlaysForCollectionGroup(e,t,n,s){const i=Pe();let o;const a=IDBKeyRange.bound([this.userId,t,n],[this.userId,t,Number.POSITIVE_INFINITY],!0);return Sn(e).ee({index:du,range:a},((u,c,l)=>{const h=Ss(this.serializer,c);i.size()<s||h.largestBatchId===o?(i.set(h.getKey(),h),o=h.largestBatchId):l.done()})).next((()=>i))}bt(e,t){return Sn(e).put((function(s,i,o){const[a,u,c]=Xo(i,o.mutation.key);return{userId:i,collectionPath:u,documentId:c,collectionGroup:o.mutation.key.getCollectionGroup(),largestBatchId:o.largestBatchId,overlayMutation:rr(s.yt,o.mutation)}})(this.serializer,this.userId,t))}}function Sn(r){return te(r,is)}/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Nd{St(e){return te(e,pi)}getSessionToken(e){return this.St(e).get("sessionToken").next((t=>{const n=t==null?void 0:t.value;return n?W.fromUint8Array(n):W.EMPTY_BYTE_STRING}))}setSessionToken(e,t){return this.St(e).put({name:"sessionToken",value:t.toUint8Array()})}}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class gt{constructor(){}Dt(e,t){this.Ct(e,t),t.vt()}Ct(e,t){if("nullValue"in e)this.Ft(t,5);else if("booleanValue"in e)this.Ft(t,10),t.Mt(e.booleanValue?1:0);else if("integerValue"in e)this.Ft(t,15),t.Mt(G(e.integerValue));else if("doubleValue"in e){const n=G(e.doubleValue);isNaN(n)?this.Ft(t,13):(this.Ft(t,15),jn(n)?t.Mt(0):t.Mt(n))}else if("timestampValue"in e){let n=e.timestampValue;this.Ft(t,20),typeof n=="string"&&(n=Fe(n)),t.xt(`${n.seconds||""}`),t.Mt(n.nanos||0)}else if("stringValue"in e)this.Ot(e.stringValue,t),this.Nt(t);else if("bytesValue"in e)this.Ft(t,30),t.Bt(Me(e.bytesValue)),this.Nt(t);else if("referenceValue"in e)this.Lt(e.referenceValue,t);else if("geoPointValue"in e){const n=e.geoPointValue;this.Ft(t,45),t.Mt(n.latitude||0),t.Mt(n.longitude||0)}else"mapValue"in e?Ru(e)?this.Ft(t,Number.MAX_SAFE_INTEGER):us(e)?this.kt(e.mapValue,t):(this.Kt(e.mapValue,t),this.Nt(t)):"arrayValue"in e?(this.qt(e.arrayValue,t),this.Nt(t)):A(19022,{Ut:e})}Ot(e,t){this.Ft(t,25),this.$t(e,t)}$t(e,t){t.xt(e)}Kt(e,t){const n=e.fields||{};this.Ft(t,55);for(const s of Object.keys(n))this.Ot(s,t),this.Ct(n[s],t)}kt(e,t){var o,a;const n=e.fields||{};this.Ft(t,53);const s=on,i=((a=(o=n[s].arrayValue)==null?void 0:o.values)==null?void 0:a.length)||0;this.Ft(t,15),t.Mt(G(i)),this.Ot(s,t),this.Ct(n[s],t)}qt(e,t){const n=e.values||[];this.Ft(t,50);for(const s of n)this.Ct(s,t)}Lt(e,t){this.Ft(t,37),E.fromName(e).path.forEach((n=>{this.Ft(t,60),this.$t(n,t)}))}Ft(e,t){e.Mt(t)}Nt(e){e.Mt(2)}}gt.Wt=new gt;/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law | agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES | CONDITIONS OF ANY KIND, either express | implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ut=255;function kd(r){if(r===0)return 8;let e=0;return r>>4||(e+=4,r<<=4),r>>6||(e+=2,r<<=2),r>>7||(e+=1),e}function na(r){const e=64-(function(n){let s=0;for(let i=0;i<8;++i){const o=kd(255&n[i]);if(s+=o,o!==8)break}return s})(r);return Math.ceil(e/8)}class Fd{constructor(){this.buffer=new Uint8Array(1024),this.position=0}Qt(e){const t=e[Symbol.iterator]();let n=t.next();for(;!n.done;)this.Gt(n.value),n=t.next();this.zt()}jt(e){const t=e[Symbol.iterator]();let n=t.next();for(;!n.done;)this.Ht(n.value),n=t.next();this.Jt()}Zt(e){for(const t of e){const n=t.charCodeAt(0);if(n<128)this.Gt(n);else if(n<2048)this.Gt(960|n>>>6),this.Gt(128|63&n);else if(t<"\uD800"||"\uDBFF"<t)this.Gt(480|n>>>12),this.Gt(128|63&n>>>6),this.Gt(128|63&n);else{const s=t.codePointAt(0);this.Gt(240|s>>>18),this.Gt(128|63&s>>>12),this.Gt(128|63&s>>>6),this.Gt(128|63&s)}}this.zt()}Xt(e){for(const t of e){const n=t.charCodeAt(0);if(n<128)this.Ht(n);else if(n<2048)this.Ht(960|n>>>6),this.Ht(128|63&n);else if(t<"\uD800"||"\uDBFF"<t)this.Ht(480|n>>>12),this.Ht(128|63&n>>>6),this.Ht(128|63&n);else{const s=t.codePointAt(0);this.Ht(240|s>>>18),this.Ht(128|63&s>>>12),this.Ht(128|63&s>>>6),this.Ht(128|63&s)}}this.Jt()}Yt(e){const t=this.en(e),n=na(t);this.tn(1+n),this.buffer[this.position++]=255&n;for(let s=t.length-n;s<t.length;++s)this.buffer[this.position++]=255&t[s]}nn(e){const t=this.en(e),n=na(t);this.tn(1+n),this.buffer[this.position++]=~(255&n);for(let s=t.length-n;s<t.length;++s)this.buffer[this.position++]=~(255&t[s])}rn(){this.sn(Ut),this.sn(255)}_n(){this.an(Ut),this.an(255)}reset(){this.position=0}seed(e){this.tn(e.length),this.buffer.set(e,this.position),this.position+=e.length}un(){return this.buffer.slice(0,this.position)}en(e){const t=(function(i){const o=new DataView(new ArrayBuffer(8));return o.setFloat64(0,i,!1),new Uint8Array(o.buffer)})(e),n=!!(128&t[0]);t[0]^=n?255:128;for(let s=1;s<t.length;++s)t[s]^=n?255:0;return t}Gt(e){const t=255&e;t===0?(this.sn(0),this.sn(255)):t===Ut?(this.sn(Ut),this.sn(0)):this.sn(t)}Ht(e){const t=255&e;t===0?(this.an(0),this.an(255)):t===Ut?(this.an(Ut),this.an(0)):this.an(e)}zt(){this.sn(0),this.sn(1)}Jt(){this.an(0),this.an(1)}sn(e){this.tn(1),this.buffer[this.position++]=e}an(e){this.tn(1),this.buffer[this.position++]=~e}tn(e){const t=e+this.position;if(t<=this.buffer.length)return;let n=2*this.buffer.length;n<t&&(n=t);const s=new Uint8Array(n);s.set(this.buffer),this.buffer=s}}class Md{constructor(e){this.cn=e}Bt(e){this.cn.Qt(e)}xt(e){this.cn.Zt(e)}Mt(e){this.cn.Yt(e)}vt(){this.cn.rn()}}class Od{constructor(e){this.cn=e}Bt(e){this.cn.jt(e)}xt(e){this.cn.Xt(e)}Mt(e){this.cn.nn(e)}vt(){this.cn._n()}}class Cn{constructor(){this.cn=new Fd,this.ascending=new Md(this.cn),this.descending=new Od(this.cn)}seed(e){this.cn.seed(e)}ln(e){return e===0?this.ascending:this.descending}un(){return this.cn.un()}reset(){this.cn.reset()}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class pt{constructor(e,t,n,s){this.hn=e,this.Pn=t,this.Tn=n,this.In=s}En(){const e=this.In.length,t=e===0||this.In[e-1]===255?e+1:e,n=new Uint8Array(t);return n.set(this.In,0),t!==e?n.set([0],this.In.length):++n[n.length-1],new pt(this.hn,this.Pn,this.Tn,n)}Rn(e,t,n){return{indexId:this.hn,uid:e,arrayValue:Mr(this.Tn),directionalValue:Mr(this.In),orderedDocumentKey:Mr(t),documentKey:n.path.toArray()}}An(e,t,n){const s=this.Rn(e,t,n);return[s.indexId,s.uid,s.arrayValue,s.directionalValue,s.orderedDocumentKey,s.documentKey]}}function Ge(r,e){let t=r.hn-e.hn;return t!==0?t:(t=ra(r.Tn,e.Tn),t!==0?t:(t=ra(r.In,e.In),t!==0?t:E.comparator(r.Pn,e.Pn)))}function ra(r,e){for(let t=0;t<r.length&&t<e.length;++t){const n=r[t]-e[t];if(n!==0)return n}return r.length-e.length}function Mr(r){return Ha()?(function(t){let n="";for(let s=0;s<t.length;s++)n+=String.fromCharCode(t[s]);return n})(r):r}function sa(r){return typeof r!="string"?r:(function(t){const n=new Uint8Array(t.length);for(let s=0;s<t.length;s++)n[s]=t.charCodeAt(s);return n})(r)}class ia{constructor(e){this.Vn=new O(((t,n)=>$.comparator(t.field,n.field))),this.collectionId=e.collectionGroup!=null?e.collectionGroup:e.path.lastSegment(),this.dn=e.orderBy,this.mn=[];for(const t of e.filters){const n=t;n.isInequality()?this.Vn=this.Vn.add(n):this.mn.push(n)}}get fn(){return this.Vn.size>1}gn(e){if(v(e.collectionGroup===this.collectionId,49279),this.fn)return!1;const t=Us(e);if(t!==void 0&&!this.pn(t))return!1;const n=dt(e);let s=new Set,i=0,o=0;for(;i<n.length&&this.pn(n[i]);++i)s=s.add(n[i].fieldPath.canonicalString());if(i===n.length)return!0;if(this.Vn.size>0){const a=this.Vn.getIterator().getNext();if(!s.has(a.field.canonicalString())){const u=n[i];if(!this.yn(a,u)||!this.wn(this.dn[o++],u))return!1}++i}for(;i<n.length;++i){const a=n[i];if(o>=this.dn.length||!this.wn(this.dn[o++],a))return!1}return!0}bn(){if(this.fn)return null;let e=new O($.comparator);const t=[];for(const n of this.mn)if(!n.field.isKeyField())if(n.op==="array-contains"||n.op==="array-contains-any")t.push(new Tt(n.field,2));else{if(e.has(n.field))continue;e=e.add(n.field),t.push(new Tt(n.field,0))}for(const n of this.dn)n.field.isKeyField()||e.has(n.field)||(e=e.add(n.field),t.push(new Tt(n.field,n.dir==="asc"?0:1)));return new Zt(Zt.UNKNOWN_ID,this.collectionId,t,en.empty())}pn(e){for(const t of this.mn)if(this.yn(t,e))return!0;return!1}yn(e,t){if(e===void 0||!e.field.isEqual(t.fieldPath))return!1;const n=e.op==="array-contains"||e.op==="array-contains-any";return t.kind===2===n}wn(e,t){return!!e.field.isEqual(t.fieldPath)&&(t.kind===0&&e.dir==="asc"||t.kind===1&&e.dir==="desc")}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function yc(r){var t,n;if(v(r instanceof N||r instanceof M,20012),r instanceof N){if(r instanceof ku){const s=((n=(t=r.value.arrayValue)==null?void 0:t.values)==null?void 0:n.map((i=>N.create(r.field,"==",i))))||[];return M.create(s,"or")}return r}const e=r.filters.map((s=>yc(s)));return M.create(e,r.op)}function Ld(r){if(r.getFilters().length===0)return[];const e=ri(yc(r));return v(Ic(e),7391),ti(e)||ni(e)?[e]:e.getFilters()}function ti(r){return r instanceof N}function ni(r){return r instanceof M&&Ei(r)}function Ic(r){return ti(r)||ni(r)||(function(t){if(t instanceof M&&js(t)){for(const n of t.getFilters())if(!ti(n)&&!ni(n))return!1;return!0}return!1})(r)}function ri(r){if(v(r instanceof N||r instanceof M,34018),r instanceof N)return r;if(r.filters.length===1)return ri(r.filters[0]);const e=r.filters.map((n=>ri(n)));let t=M.create(e,r.op);return t=jr(t),Ic(t)?t:(v(t instanceof M,64498),v(un(t),40251),v(t.filters.length>1,57927),t.filters.reduce(((n,s)=>xi(n,s))))}function xi(r,e){let t;return v(r instanceof N||r instanceof M,38388),v(e instanceof N||e instanceof M,25473),t=r instanceof N?e instanceof N?(function(s,i){return M.create([s,i],"and")})(r,e):oa(r,e):e instanceof N?oa(e,r):(function(s,i){if(v(s.filters.length>0&&i.filters.length>0,48005),un(s)&&un(i))return xu(s,i.getFilters());const o=js(s)?s:i,a=js(s)?i:s,u=o.filters.map((c=>xi(c,a)));return M.create(u,"or")})(r,e),jr(t)}function oa(r,e){if(un(e))return xu(e,r.getFilters());{const t=e.filters.map((n=>xi(r,n)));return M.create(t,"or")}}function jr(r){if(v(r instanceof N||r instanceof M,11850),r instanceof N)return r;const e=r.getFilters();if(e.length===1)return jr(e[0]);if(Su(r))return r;const t=e.map((s=>jr(s))),n=[];return t.forEach((s=>{s instanceof N?n.push(s):s instanceof M&&(s.op===r.op?n.push(...s.filters):n.push(s))})),n.length===1?n[0]:M.create(n,r.op)}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class qd{constructor(){this.Sn=new Di}addToCollectionParentIndex(e,t){return this.Sn.add(t),f.resolve()}getCollectionParents(e,t){return f.resolve(this.Sn.getEntries(t))}addFieldIndex(e,t){return f.resolve()}deleteFieldIndex(e,t){return f.resolve()}deleteAllFieldIndexes(e){return f.resolve()}createTargetIndexes(e,t){return f.resolve()}getDocumentsMatchingTarget(e,t){return f.resolve(null)}getIndexType(e,t){return f.resolve(0)}getFieldIndexes(e,t){return f.resolve([])}getNextCollectionGroupToUpdate(e){return f.resolve(null)}getMinOffset(e,t){return f.resolve(Ee.min())}getMinOffsetFromCollectionGroup(e,t){return f.resolve(Ee.min())}updateCollectionGroup(e,t,n){return f.resolve()}updateIndexEntries(e,t){return f.resolve()}}class Di{constructor(){this.index={}}add(e){const t=e.lastSegment(),n=e.popLast(),s=this.index[t]||new O(x.comparator),i=!s.has(n);return this.index[t]=s.add(n),i}has(e){const t=e.lastSegment(),n=e.popLast(),s=this.index[t];return s&&s.has(n)}getEntries(e){return(this.index[e]||new O(x.comparator)).toArray()}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const aa="IndexedDbIndexManager",vr=new Uint8Array(0);class Ud{constructor(e,t){this.databaseId=t,this.Dn=new Di,this.Cn=new qe((n=>Rt(n)),((n,s)=>cr(n,s))),this.uid=e.uid||""}addToCollectionParentIndex(e,t){if(!this.Dn.has(t)){const n=t.lastSegment(),s=t.popLast();e.addOnCommittedListener((()=>{this.Dn.add(t)}));const i={collectionId:n,parent:le(s)};return ua(e).put(i)}return f.resolve()}getCollectionParents(e,t){const n=[],s=IDBKeyRange.bound([t,""],[Xa(t),""],!1,!0);return ua(e).H(s).next((i=>{for(const o of i){if(o.collectionId!==t)break;n.push(Ve(o.parent))}return n}))}addFieldIndex(e,t){const n=xn(e),s=(function(a){return{indexId:a.indexId,collectionGroup:a.collectionGroup,fields:a.fields.map((u=>[u.fieldPath.canonicalString(),u.kind]))}})(t);delete s.indexId;const i=n.add(s);if(t.indexState){const o=zt(e);return i.next((a=>{o.put(Zo(a,this.uid,t.indexState.sequenceNumber,t.indexState.offset))}))}return i.next()}deleteFieldIndex(e,t){const n=xn(e),s=zt(e),i=Bt(e);return n.delete(t.indexId).next((()=>s.delete(IDBKeyRange.bound([t.indexId],[t.indexId+1],!1,!0)))).next((()=>i.delete(IDBKeyRange.bound([t.indexId],[t.indexId+1],!1,!0))))}deleteAllFieldIndexes(e){const t=xn(e),n=Bt(e),s=zt(e);return t.X().next((()=>n.X())).next((()=>s.X()))}createTargetIndexes(e,t){return f.forEach(this.vn(t),(n=>this.getIndexType(e,n).next((s=>{if(s===0||s===1){const i=new ia(n).bn();if(i!=null)return this.addFieldIndex(e,i)}}))))}getDocumentsMatchingTarget(e,t){const n=Bt(e);let s=!0;const i=new Map;return f.forEach(this.vn(t),(o=>this.Fn(e,o).next((a=>{s&&(s=!!a),i.set(o,a)})))).next((()=>{if(s){let o=C();const a=[];return f.forEach(i,((u,c)=>{p(aa,`Using index ${(function(b){return`id=${b.indexId}|cg=${b.collectionGroup}|f=${b.fields.map((Q=>`${Q.fieldPath}:${Q.kind}`)).join(",")}`})(u)} to execute ${Rt(t)}`);const l=(function(b,Q){const z=Us(Q);if(z===void 0)return null;for(const Z of $r(b,z.fieldPath))switch(Z.op){case"array-contains-any":return Z.value.arrayValue.values||[];case"array-contains":return[Z.value]}return null})(c,u),h=(function(b,Q){const z=new Map;for(const Z of dt(Q))for(const de of $r(b,Z.fieldPath))switch(de.op){case"==":case"in":z.set(Z.fieldPath.canonicalString(),de.value);break;case"not-in":case"!=":return z.set(Z.fieldPath.canonicalString(),de.value),Array.from(z.values())}return null})(c,u),d=(function(b,Q){const z=[];let Z=!0;for(const de of dt(Q)){const ze=de.kind===0?qo(b,de.fieldPath,b.startAt):Uo(b,de.fieldPath,b.startAt);z.push(ze.value),Z&&(Z=ze.inclusive)}return new tt(z,Z)})(c,u),_=(function(b,Q){const z=[];let Z=!0;for(const de of dt(Q)){const ze=de.kind===0?Uo(b,de.fieldPath,b.endAt):qo(b,de.fieldPath,b.endAt);z.push(ze.value),Z&&(Z=ze.inclusive)}return new tt(z,Z)})(c,u),y=this.Mn(u,c,d),I=this.Mn(u,c,_),T=this.xn(u,c,h),V=this.On(u.indexId,l,y,d.inclusive,I,_.inclusive,T);return f.forEach(V,(S=>n.Z(S,t.limit).next((b=>{b.forEach((Q=>{const z=E.fromSegments(Q.documentKey);o.has(z)||(o=o.add(z),a.push(z))}))}))))})).next((()=>a))}return f.resolve(null)}))}vn(e){let t=this.Cn.get(e);return t||(e.filters.length===0?t=[e]:t=Ld(M.create(e.filters,"and")).map((n=>Hs(e.path,e.collectionGroup,e.orderBy,n.getFilters(),e.limit,e.startAt,e.endAt))),this.Cn.set(e,t),t)}On(e,t,n,s,i,o,a){const u=(t!=null?t.length:1)*Math.max(n.length,i.length),c=u/(t!=null?t.length:1),l=[];for(let h=0;h<u;++h){const d=t?this.Nn(t[h/c]):vr,_=this.Bn(e,d,n[h%c],s),y=this.Ln(e,d,i[h%c],o),I=a.map((T=>this.Bn(e,d,T,!0)));l.push(...this.createRange(_,y,I))}return l}Bn(e,t,n,s){const i=new pt(e,E.empty(),t,n);return s?i:i.En()}Ln(e,t,n,s){const i=new pt(e,E.empty(),t,n);return s?i.En():i}Fn(e,t){const n=new ia(t),s=t.collectionGroup!=null?t.collectionGroup:t.path.lastSegment();return this.getFieldIndexes(e,s).next((i=>{let o=null;for(const a of i)n.gn(a)&&(!o||a.fields.length>o.fields.length)&&(o=a);return o}))}getIndexType(e,t){let n=2;const s=this.vn(t);return f.forEach(s,(i=>this.Fn(e,i).next((o=>{o?n!==0&&o.fields.length<(function(u){let c=new O($.comparator),l=!1;for(const h of u.filters)for(const d of h.getFlattenedFilters())d.field.isKeyField()||(d.op==="array-contains"||d.op==="array-contains-any"?l=!0:c=c.add(d.field));for(const h of u.orderBy)h.field.isKeyField()||(c=c.add(h.field));return c.size+(l?1:0)})(i)&&(n=1):n=0})))).next((()=>(function(o){return o.limit!==null})(t)&&s.length>1&&n===2?1:n))}kn(e,t){const n=new Cn;for(const s of dt(e)){const i=t.data.field(s.fieldPath);if(i==null)return null;const o=n.ln(s.kind);gt.Wt.Dt(i,o)}return n.un()}Nn(e){const t=new Cn;return gt.Wt.Dt(e,t.ln(0)),t.un()}Kn(e,t){const n=new Cn;return gt.Wt.Dt(vt(this.databaseId,t),n.ln((function(i){const o=dt(i);return o.length===0?0:o[o.length-1].kind})(e))),n.un()}xn(e,t,n){if(n===null)return[];let s=[];s.push(new Cn);let i=0;for(const o of dt(e)){const a=n[i++];for(const u of s)if(this.qn(t,o.fieldPath)&&er(a))s=this.Un(s,o,a);else{const c=u.ln(o.kind);gt.Wt.Dt(a,c)}}return this.$n(s)}Mn(e,t,n){return this.xn(e,t,n.position)}$n(e){const t=[];for(let n=0;n<e.length;++n)t[n]=e[n].un();return t}Un(e,t,n){const s=[...e],i=[];for(const o of n.arrayValue.values||[])for(const a of s){const u=new Cn;u.seed(a.un()),gt.Wt.Dt(o,u.ln(t.kind)),i.push(u)}return i}qn(e,t){return!!e.filters.find((n=>n instanceof N&&n.field.isEqual(t)&&(n.op==="in"||n.op==="not-in")))}getFieldIndexes(e,t){const n=xn(e),s=zt(e);return(t?n.H(zs,IDBKeyRange.bound(t,t)):n.H()).next((i=>{const o=[];return f.forEach(i,(a=>s.get([a.indexId,this.uid]).next((u=>{o.push((function(l,h){const d=h?new en(h.sequenceNumber,new Ee(St(h.readTime),new E(Ve(h.documentKey)),h.largestBatchId)):en.empty(),_=l.fields.map((([y,I])=>new Tt($.fromServerFormat(y),I)));return new Zt(l.indexId,l.collectionGroup,_,d)})(a,u))})))).next((()=>o))}))}getNextCollectionGroupToUpdate(e){return this.getFieldIndexes(e).next((t=>t.length===0?null:(t.sort(((n,s)=>{const i=n.indexState.sequenceNumber-s.indexState.sequenceNumber;return i!==0?i:P(n.collectionGroup,s.collectionGroup)})),t[0].collectionGroup)))}updateCollectionGroup(e,t,n){const s=xn(e),i=zt(e);return this.Wn(e).next((o=>s.H(zs,IDBKeyRange.bound(t,t)).next((a=>f.forEach(a,(u=>i.put(Zo(u.indexId,this.uid,o,n))))))))}updateIndexEntries(e,t){const n=new Map;return f.forEach(t,((s,i)=>{const o=n.get(s.collectionGroup);return(o?f.resolve(o):this.getFieldIndexes(e,s.collectionGroup)).next((a=>(n.set(s.collectionGroup,a),f.forEach(a,(u=>this.Qn(e,s,u).next((c=>{const l=this.Gn(i,u);return c.isEqual(l)?f.resolve():this.zn(e,i,u,c,l)})))))))}))}jn(e,t,n,s){return Bt(e).put(s.Rn(this.uid,this.Kn(n,t.key),t.key))}Hn(e,t,n,s){return Bt(e).delete(s.An(this.uid,this.Kn(n,t.key),t.key))}Qn(e,t,n){const s=Bt(e);let i=new O(Ge);return s.ee({index:hu,range:IDBKeyRange.only([n.indexId,this.uid,Mr(this.Kn(n,t))])},((o,a)=>{i=i.add(new pt(n.indexId,t,sa(a.arrayValue),sa(a.directionalValue)))})).next((()=>i))}Gn(e,t){let n=new O(Ge);const s=this.kn(t,e);if(s==null)return n;const i=Us(t);if(i!=null){const o=e.data.field(i.fieldPath);if(er(o))for(const a of o.arrayValue.values||[])n=n.add(new pt(t.indexId,e.key,this.Nn(a),s))}else n=n.add(new pt(t.indexId,e.key,vr,s));return n}zn(e,t,n,s,i){p(aa,"Updating index entries for document '%s'",t.key);const o=[];return(function(u,c,l,h,d){const _=u.getIterator(),y=c.getIterator();let I=qt(_),T=qt(y);for(;I||T;){let V=!1,S=!1;if(I&&T){const b=l(I,T);b<0?S=!0:b>0&&(V=!0)}else I!=null?S=!0:V=!0;V?(h(T),T=qt(y)):S?(d(I),I=qt(_)):(I=qt(_),T=qt(y))}})(s,i,Ge,(a=>{o.push(this.jn(e,t,n,a))}),(a=>{o.push(this.Hn(e,t,n,a))})),f.waitFor(o)}Wn(e){let t=1;return zt(e).ee({index:lu,reverse:!0,range:IDBKeyRange.upperBound([this.uid,Number.MAX_SAFE_INTEGER])},((n,s,i)=>{i.done(),t=s.sequenceNumber+1})).next((()=>t))}createRange(e,t,n){n=n.sort(((o,a)=>Ge(o,a))).filter(((o,a,u)=>!a||Ge(o,u[a-1])!==0));const s=[];s.push(e);for(const o of n){const a=Ge(o,e),u=Ge(o,t);if(a===0)s[0]=e.En();else if(a>0&&u<0)s.push(o),s.push(o.En());else if(u>0)break}s.push(t);const i=[];for(let o=0;o<s.length;o+=2){if(this.Jn(s[o],s[o+1]))return[];const a=s[o].An(this.uid,vr,E.empty()),u=s[o+1].An(this.uid,vr,E.empty());i.push(IDBKeyRange.bound(a,u))}return i}Jn(e,t){return Ge(e,t)>0}getMinOffsetFromCollectionGroup(e,t){return this.getFieldIndexes(e,t).next(ca)}getMinOffset(e,t){return f.mapArray(this.vn(t),(n=>this.Fn(e,n).next((s=>s||A(44426))))).next(ca)}}function ua(r){return te(r,Jn)}function Bt(r){return te(r,Bn)}function xn(r){return te(r,gi)}function zt(r){return te(r,Un)}function ca(r){v(r.length!==0,28825);let e=r[0].indexState.offset,t=e.largestBatchId;for(let n=1;n<r.length;n++){const s=r[n].indexState.offset;fi(s,e)<0&&(e=s),t<s.largestBatchId&&(t=s.largestBatchId)}return new Ee(e.readTime,e.documentKey,t)}/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const la={didRun:!1,sequenceNumbersCollected:0,targetsRemoved:0,documentsRemoved:0},Tc=41943040;class ce{static withCacheSize(e){return new ce(e,ce.DEFAULT_COLLECTION_PERCENTILE,ce.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT)}constructor(e,t,n){this.cacheSizeCollectionThreshold=e,this.percentileToCollect=t,this.maximumSequenceNumbersToCollect=n}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Ec(r,e,t){const n=r.store(Ae),s=r.store(tn),i=[],o=IDBKeyRange.only(t.batchId);let a=0;const u=n.ee({range:o},((l,h,d)=>(a++,d.delete())));i.push(u.next((()=>{v(a===1,47070,{batchId:t.batchId})})));const c=[];for(const l of t.mutations){const h=au(e,l.key.path,t.batchId);i.push(s.delete(h)),c.push(l.key)}return f.waitFor(i).next((()=>c))}function Wr(r){if(!r)return 0;let e;if(r.document)e=r.document;else if(r.unknownDocument)e=r.unknownDocument;else{if(!r.noDocument)throw A(14731);e=r.noDocument}return JSON.stringify(e).length}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */ce.DEFAULT_COLLECTION_PERCENTILE=10,ce.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT=1e3,ce.DEFAULT=new ce(Tc,ce.DEFAULT_COLLECTION_PERCENTILE,ce.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT),ce.DISABLED=new ce(-1,0,0);class _s{constructor(e,t,n,s){this.userId=e,this.serializer=t,this.indexManager=n,this.referenceDelegate=s,this.Zn={}}static wt(e,t,n,s){v(e.uid!=="",64387);const i=e.isAuthenticated()?e.uid:"";return new _s(i,t,n,s)}checkEmpty(e){let t=!0;const n=IDBKeyRange.bound([this.userId,Number.NEGATIVE_INFINITY],[this.userId,Number.POSITIVE_INFINITY]);return $e(e).ee({index:yt,range:n},((s,i,o)=>{t=!1,o.done()})).next((()=>t))}addMutationBatch(e,t,n,s){const i=jt(e),o=$e(e);return o.add({}).next((a=>{v(typeof a=="number",49019);const u=new Vi(a,t,n,s),c=(function(_,y,I){const T=I.baseMutations.map((S=>rr(_.yt,S))),V=I.mutations.map((S=>rr(_.yt,S)));return{userId:y,batchId:I.batchId,localWriteTimeMs:I.localWriteTime.toMillis(),baseMutations:T,mutations:V}})(this.serializer,this.userId,u),l=[];let h=new O(((d,_)=>P(d.canonicalString(),_.canonicalString())));for(const d of s){const _=au(this.userId,d.key.path,a);h=h.add(d.key.path.popLast()),l.push(o.put(c)),l.push(i.put(_,gh))}return h.forEach((d=>{l.push(this.indexManager.addToCollectionParentIndex(e,d))})),e.addOnCommittedListener((()=>{this.Zn[a]=u.keys()})),f.waitFor(l).next((()=>u))}))}lookupMutationBatch(e,t){return $e(e).get(t).next((n=>n?(v(n.userId===this.userId,48,"Unexpected user for mutation batch",{userId:n.userId,batchId:t}),_t(this.serializer,n)):null))}Xn(e,t){return this.Zn[t]?f.resolve(this.Zn[t]):this.lookupMutationBatch(e,t).next((n=>{if(n){const s=n.keys();return this.Zn[t]=s,s}return null}))}getNextMutationBatchAfterBatchId(e,t){const n=t+1,s=IDBKeyRange.lowerBound([this.userId,n]);let i=null;return $e(e).ee({index:yt,range:s},((o,a,u)=>{a.userId===this.userId&&(v(a.batchId>=n,47524,{Yn:n}),i=_t(this.serializer,a)),u.done()})).next((()=>i))}getHighestUnacknowledgedBatchId(e){const t=IDBKeyRange.upperBound([this.userId,Number.POSITIVE_INFINITY]);let n=Ye;return $e(e).ee({index:yt,range:t,reverse:!0},((s,i,o)=>{n=i.batchId,o.done()})).next((()=>n))}getAllMutationBatches(e){const t=IDBKeyRange.bound([this.userId,Ye],[this.userId,Number.POSITIVE_INFINITY]);return $e(e).H(yt,t).next((n=>n.map((s=>_t(this.serializer,s)))))}getAllMutationBatchesAffectingDocumentKey(e,t){const n=Sr(this.userId,t.path),s=IDBKeyRange.lowerBound(n),i=[];return jt(e).ee({range:s},((o,a,u)=>{const[c,l,h]=o,d=Ve(l);if(c===this.userId&&t.path.isEqual(d))return $e(e).get(h).next((_=>{if(!_)throw A(61480,{er:o,batchId:h});v(_.userId===this.userId,10503,"Unexpected user for mutation batch",{userId:_.userId,batchId:h}),i.push(_t(this.serializer,_))}));u.done()})).next((()=>i))}getAllMutationBatchesAffectingDocumentKeys(e,t){let n=new O(P);const s=[];return t.forEach((i=>{const o=Sr(this.userId,i.path),a=IDBKeyRange.lowerBound(o),u=jt(e).ee({range:a},((c,l,h)=>{const[d,_,y]=c,I=Ve(_);d===this.userId&&i.path.isEqual(I)?n=n.add(y):h.done()}));s.push(u)})),f.waitFor(s).next((()=>this.tr(e,n)))}getAllMutationBatchesAffectingQuery(e,t){const n=t.path,s=n.length+1,i=Sr(this.userId,n),o=IDBKeyRange.lowerBound(i);let a=new O(P);return jt(e).ee({range:o},((u,c,l)=>{const[h,d,_]=u,y=Ve(d);h===this.userId&&n.isPrefixOf(y)?y.length===s&&(a=a.add(_)):l.done()})).next((()=>this.tr(e,a)))}tr(e,t){const n=[],s=[];return t.forEach((i=>{s.push($e(e).get(i).next((o=>{if(o===null)throw A(35274,{batchId:i});v(o.userId===this.userId,9748,"Unexpected user for mutation batch",{userId:o.userId,batchId:i}),n.push(_t(this.serializer,o))})))})),f.waitFor(s).next((()=>n))}removeMutationBatch(e,t){return Ec(e.le,this.userId,t).next((n=>(e.addOnCommittedListener((()=>{this.nr(t.batchId)})),f.forEach(n,(s=>this.referenceDelegate.markPotentiallyOrphaned(e,s))))))}nr(e){delete this.Zn[e]}performConsistencyCheck(e){return this.checkEmpty(e).next((t=>{if(!t)return f.resolve();const n=IDBKeyRange.lowerBound((function(o){return[o]})(this.userId)),s=[];return jt(e).ee({range:n},((i,o,a)=>{if(i[0]===this.userId){const u=Ve(i[1]);s.push(u)}else a.done()})).next((()=>{v(s.length===0,56720,{rr:s.map((i=>i.canonicalString()))})}))}))}containsKey(e,t){return wc(e,this.userId,t)}ir(e){return Ac(e).get(this.userId).next((t=>t||{userId:this.userId,lastAcknowledgedBatchId:Ye,lastStreamToken:""}))}}function wc(r,e,t){const n=Sr(e,t.path),s=n[1],i=IDBKeyRange.lowerBound(n);let o=!1;return jt(r).ee({range:i,Y:!0},((a,u,c)=>{const[l,h,d]=a;l===e&&h===s&&(o=!0),c.done()})).next((()=>o))}function $e(r){return te(r,Ae)}function jt(r){return te(r,tn)}function Ac(r){return te(r,Wn)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ct{constructor(e){this.sr=e}next(){return this.sr+=2,this.sr}static _r(){return new Ct(0)}static ar(){return new Ct(-1)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Bd{constructor(e,t){this.referenceDelegate=e,this.serializer=t}allocateTargetId(e){return this.ur(e).next((t=>{const n=new Ct(t.highestTargetId);return t.highestTargetId=n.next(),this.cr(e,t).next((()=>t.highestTargetId))}))}getLastRemoteSnapshotVersion(e){return this.ur(e).next((t=>R.fromTimestamp(new F(t.lastRemoteSnapshotVersion.seconds,t.lastRemoteSnapshotVersion.nanoseconds))))}getHighestSequenceNumber(e){return this.ur(e).next((t=>t.highestListenSequenceNumber))}setTargetsMetadata(e,t,n){return this.ur(e).next((s=>(s.highestListenSequenceNumber=t,n&&(s.lastRemoteSnapshotVersion=n.toTimestamp()),t>s.highestListenSequenceNumber&&(s.highestListenSequenceNumber=t),this.cr(e,s))))}addTargetData(e,t){return this.lr(e,t).next((()=>this.ur(e).next((n=>(n.targetCount+=1,this.hr(t,n),this.cr(e,n))))))}updateTargetData(e,t){return this.lr(e,t)}removeTargetData(e,t){return this.removeMatchingKeysForTargetId(e,t.targetId).next((()=>Gt(e).delete(t.targetId))).next((()=>this.ur(e))).next((n=>(v(n.targetCount>0,8065),n.targetCount-=1,this.cr(e,n))))}removeTargets(e,t,n){let s=0;const i=[];return Gt(e).ee(((o,a)=>{const u=On(a);u.sequenceNumber<=t&&n.get(u.targetId)===null&&(s++,i.push(this.removeTargetData(e,u)))})).next((()=>f.waitFor(i))).next((()=>s))}forEachTarget(e,t){return Gt(e).ee(((n,s)=>{const i=On(s);t(i)}))}ur(e){return ha(e).get(zr).next((t=>(v(t!==null,2888),t)))}cr(e,t){return ha(e).put(zr,t)}lr(e,t){return Gt(e).put(pc(this.serializer,t))}hr(e,t){let n=!1;return e.targetId>t.highestTargetId&&(t.highestTargetId=e.targetId,n=!0),e.sequenceNumber>t.highestListenSequenceNumber&&(t.highestListenSequenceNumber=e.sequenceNumber,n=!0),n}getTargetCount(e){return this.ur(e).next((t=>t.targetCount))}getTargetData(e,t){const n=Rt(t),s=IDBKeyRange.bound([n,Number.NEGATIVE_INFINITY],[n,Number.POSITIVE_INFINITY]);let i=null;return Gt(e).ee({range:s,index:cu},((o,a,u)=>{const c=On(a);cr(t,c.target)&&(i=c,u.done())})).next((()=>i))}addMatchingKeys(e,t,n){const s=[],i=je(e);return t.forEach((o=>{const a=le(o.path);s.push(i.put({targetId:n,path:a})),s.push(this.referenceDelegate.addReference(e,n,o))})),f.waitFor(s)}removeMatchingKeys(e,t,n){const s=je(e);return f.forEach(t,(i=>{const o=le(i.path);return f.waitFor([s.delete([n,o]),this.referenceDelegate.removeReference(e,n,i)])}))}removeMatchingKeysForTargetId(e,t){const n=je(e),s=IDBKeyRange.bound([t],[t+1],!1,!0);return n.delete(s)}getMatchingKeysForTargetId(e,t){const n=IDBKeyRange.bound([t],[t+1],!1,!0),s=je(e);let i=C();return s.ee({range:n,Y:!0},((o,a,u)=>{const c=Ve(o[1]),l=new E(c);i=i.add(l)})).next((()=>i))}containsKey(e,t){const n=le(t.path),s=IDBKeyRange.bound([n],[Xa(n)],!1,!0);let i=0;return je(e).ee({index:_i,Y:!0,range:s},(([o,a],u,c)=>{o!==0&&(i++,c.done())})).next((()=>i>0))}At(e,t){return Gt(e).get(t).next((n=>n?On(n):null))}}function Gt(r){return te(r,nn)}function ha(r){return te(r,Et)}function je(r){return te(r,rn)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const da="LruGarbageCollector",vc=1048576;function fa([r,e],[t,n]){const s=P(r,t);return s===0?P(e,n):s}class zd{constructor(e){this.Pr=e,this.buffer=new O(fa),this.Tr=0}Ir(){return++this.Tr}Er(e){const t=[e,this.Ir()];if(this.buffer.size<this.Pr)this.buffer=this.buffer.add(t);else{const n=this.buffer.last();fa(t,n)<0&&(this.buffer=this.buffer.delete(n).add(t))}}get maxValue(){return this.buffer.last()[0]}}class Rc{constructor(e,t,n){this.garbageCollector=e,this.asyncQueue=t,this.localStore=n,this.Rr=null}start(){this.garbageCollector.params.cacheSizeCollectionThreshold!==-1&&this.Ar(6e4)}stop(){this.Rr&&(this.Rr.cancel(),this.Rr=null)}get started(){return this.Rr!==null}Ar(e){p(da,`Garbage collection scheduled in ${e}ms`),this.Rr=this.asyncQueue.enqueueAfterDelay("lru_garbage_collection",e,(async()=>{this.Rr=null;try{await this.localStore.collectGarbage(this.garbageCollector)}catch(t){ot(t)?p(da,"Ignoring IndexedDB error during garbage collection: ",t):await it(t)}await this.Ar(3e5)}))}}class Gd{constructor(e,t){this.Vr=e,this.params=t}calculateTargetCount(e,t){return this.Vr.dr(e).next((n=>Math.floor(t/100*n)))}nthSequenceNumber(e,t){if(t===0)return f.resolve(fe.ce);const n=new zd(t);return this.Vr.forEachTarget(e,(s=>n.Er(s.sequenceNumber))).next((()=>this.Vr.mr(e,(s=>n.Er(s))))).next((()=>n.maxValue))}removeTargets(e,t,n){return this.Vr.removeTargets(e,t,n)}removeOrphanedDocuments(e,t){return this.Vr.removeOrphanedDocuments(e,t)}collect(e,t){return this.params.cacheSizeCollectionThreshold===-1?(p("LruGarbageCollector","Garbage collection skipped; disabled"),f.resolve(la)):this.getCacheSize(e).next((n=>n<this.params.cacheSizeCollectionThreshold?(p("LruGarbageCollector",`Garbage collection skipped; Cache size ${n} is lower than threshold ${this.params.cacheSizeCollectionThreshold}`),la):this.gr(e,t)))}getCacheSize(e){return this.Vr.getCacheSize(e)}gr(e,t){let n,s,i,o,a,u,c;const l=Date.now();return this.calculateTargetCount(e,this.params.percentileToCollect).next((h=>(h>this.params.maximumSequenceNumbersToCollect?(p("LruGarbageCollector",`Capping sequence numbers to collect down to the maximum of ${this.params.maximumSequenceNumbersToCollect} from ${h}`),s=this.params.maximumSequenceNumbersToCollect):s=h,o=Date.now(),this.nthSequenceNumber(e,s)))).next((h=>(n=h,a=Date.now(),this.removeTargets(e,n,t)))).next((h=>(i=h,u=Date.now(),this.removeOrphanedDocuments(e,n)))).next((h=>(c=Date.now(),$t()<=Ne.DEBUG&&p("LruGarbageCollector",`LRU Garbage Collection
	Counted targets in ${o-l}ms
	Determined least recently used ${s} in `+(a-o)+`ms
	Removed ${i} targets in `+(u-a)+`ms
	Removed ${h} documents in `+(c-u)+`ms
Total Duration: ${c-l}ms`),f.resolve({didRun:!0,sequenceNumbersCollected:s,targetsRemoved:i,documentsRemoved:h}))))}}function Vc(r,e){return new Gd(r,e)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class $d{constructor(e,t){this.db=e,this.garbageCollector=Vc(this,t)}dr(e){const t=this.pr(e);return this.db.getTargetCache().getTargetCount(e).next((n=>t.next((s=>n+s))))}pr(e){let t=0;return this.mr(e,(n=>{t++})).next((()=>t))}forEachTarget(e,t){return this.db.getTargetCache().forEachTarget(e,t)}mr(e,t){return this.yr(e,((n,s)=>t(s)))}addReference(e,t,n){return Rr(e,n)}removeReference(e,t,n){return Rr(e,n)}removeTargets(e,t,n){return this.db.getTargetCache().removeTargets(e,t,n)}markPotentiallyOrphaned(e,t){return Rr(e,t)}wr(e,t){return(function(s,i){let o=!1;return Ac(s).te((a=>wc(s,a,i).next((u=>(u&&(o=!0),f.resolve(!u)))))).next((()=>o))})(e,t)}removeOrphanedDocuments(e,t){const n=this.db.getRemoteDocumentCache().newChangeBuffer(),s=[];let i=0;return this.yr(e,((o,a)=>{if(a<=t){const u=this.wr(e,o).next((c=>{if(!c)return i++,n.getEntry(e,o).next((()=>(n.removeEntry(o,R.min()),je(e).delete((function(h){return[0,le(h.path)]})(o)))))}));s.push(u)}})).next((()=>f.waitFor(s))).next((()=>n.apply(e))).next((()=>i))}removeTarget(e,t){const n=t.withSequenceNumber(e.currentSequenceNumber);return this.db.getTargetCache().updateTargetData(e,n)}updateLimboDocument(e,t){return Rr(e,t)}yr(e,t){const n=je(e);let s,i=fe.ce;return n.ee({index:_i},(([o,a],{path:u,sequenceNumber:c})=>{o===0?(i!==fe.ce&&t(new E(Ve(s)),i),i=c,s=u):i=fe.ce})).next((()=>{i!==fe.ce&&t(new E(Ve(s)),i)}))}getCacheSize(e){return this.db.getRemoteDocumentCache().getSize(e)}}function Rr(r,e){return je(r).put((function(n,s){return{targetId:0,path:le(n.path),sequenceNumber:s}})(e,r.currentSequenceNumber))}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Pc{constructor(){this.changes=new qe((e=>e.toString()),((e,t)=>e.isEqual(t))),this.changesApplied=!1}addEntry(e){this.assertNotApplied(),this.changes.set(e.key,e)}removeEntry(e,t){this.assertNotApplied(),this.changes.set(e,B.newInvalidDocument(e).setReadTime(t))}getEntry(e,t){this.assertNotApplied();const n=this.changes.get(t);return n!==void 0?f.resolve(n):this.getFromCache(e,t)}getEntries(e,t){return this.getAllFromCache(e,t)}apply(e){return this.assertNotApplied(),this.changesApplied=!0,this.applyChanges(e)}assertNotApplied(){}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Kd{constructor(e){this.serializer=e}setIndexManager(e){this.indexManager=e}addEntry(e,t,n){return ht(e).put(n)}removeEntry(e,t,n){return ht(e).delete((function(i,o){const a=i.path.toArray();return[a.slice(0,a.length-2),a[a.length-2],Qr(o),a[a.length-1]]})(t,n))}updateMetadata(e,t){return this.getMetadata(e).next((n=>(n.byteSize+=t,this.br(e,n))))}getEntry(e,t){let n=B.newInvalidDocument(t);return ht(e).ee({index:Cr,range:IDBKeyRange.only(Dn(t))},((s,i)=>{n=this.Sr(t,i)})).next((()=>n))}Dr(e,t){let n={size:0,document:B.newInvalidDocument(t)};return ht(e).ee({index:Cr,range:IDBKeyRange.only(Dn(t))},((s,i)=>{n={document:this.Sr(t,i),size:Wr(i)}})).next((()=>n))}getEntries(e,t){let n=_e();return this.Cr(e,t,((s,i)=>{const o=this.Sr(s,i);n=n.insert(s,o)})).next((()=>n))}vr(e,t){let n=_e(),s=new U(E.comparator);return this.Cr(e,t,((i,o)=>{const a=this.Sr(i,o);n=n.insert(i,a),s=s.insert(i,Wr(o))})).next((()=>({documents:n,Fr:s})))}Cr(e,t,n){if(t.isEmpty())return f.resolve();let s=new O(ga);t.forEach((u=>s=s.add(u)));const i=IDBKeyRange.bound(Dn(s.first()),Dn(s.last())),o=s.getIterator();let a=o.getNext();return ht(e).ee({index:Cr,range:i},((u,c,l)=>{const h=E.fromSegments([...c.prefixPath,c.collectionGroup,c.documentId]);for(;a&&ga(a,h)<0;)n(a,null),a=o.getNext();a&&a.isEqual(h)&&(n(a,c),a=o.hasNext()?o.getNext():null),a?l.j(Dn(a)):l.done()})).next((()=>{for(;a;)n(a,null),a=o.hasNext()?o.getNext():null}))}getDocumentsMatchingQuery(e,t,n,s,i){const o=t.path,a=[o.popLast().toArray(),o.lastSegment(),Qr(n.readTime),n.documentKey.path.isEmpty()?"":n.documentKey.path.lastSegment()],u=[o.popLast().toArray(),o.lastSegment(),[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],""];return ht(e).H(IDBKeyRange.bound(a,u,!0)).next((c=>{i==null||i.incrementDocumentReadCount(c.length);let l=_e();for(const h of c){const d=this.Sr(E.fromSegments(h.prefixPath.concat(h.collectionGroup,h.documentId)),h);d.isFoundDocument()&&(hr(t,d)||s.has(d.key))&&(l=l.insert(d.key,d))}return l}))}getAllFromCollectionGroup(e,t,n,s){let i=_e();const o=_a(t,n),a=_a(t,Ee.max());return ht(e).ee({index:uu,range:IDBKeyRange.bound(o,a,!0)},((u,c,l)=>{const h=this.Sr(E.fromSegments(c.prefixPath.concat(c.collectionGroup,c.documentId)),c);i=i.insert(h.key,h),i.size===s&&l.done()})).next((()=>i))}newChangeBuffer(e){return new Qd(this,!!e&&e.trackRemovals)}getSize(e){return this.getMetadata(e).next((t=>t.byteSize))}getMetadata(e){return ma(e).get(Bs).next((t=>(v(!!t,20021),t)))}br(e,t){return ma(e).put(Bs,t)}Sr(e,t){if(t){const n=xd(this.serializer,t);if(!(n.isNoDocument()&&n.version.isEqual(R.min())))return n}return B.newInvalidDocument(e)}}function bc(r){return new Kd(r)}class Qd extends Pc{constructor(e,t){super(),this.Mr=e,this.trackRemovals=t,this.Or=new qe((n=>n.toString()),((n,s)=>n.isEqual(s)))}applyChanges(e){const t=[];let n=0,s=new O(((i,o)=>P(i.canonicalString(),o.canonicalString())));return this.changes.forEach(((i,o)=>{const a=this.Or.get(i);if(t.push(this.Mr.removeEntry(e,i,a.readTime)),o.isValidDocument()){const u=Yo(this.Mr.serializer,o);s=s.add(i.path.popLast());const c=Wr(u);n+=c-a.size,t.push(this.Mr.addEntry(e,i,u))}else if(n-=a.size,this.trackRemovals){const u=Yo(this.Mr.serializer,o.convertToNoDocument(R.min()));t.push(this.Mr.addEntry(e,i,u))}})),s.forEach((i=>{t.push(this.Mr.indexManager.addToCollectionParentIndex(e,i))})),t.push(this.Mr.updateMetadata(e,n)),f.waitFor(t)}getFromCache(e,t){return this.Mr.Dr(e,t).next((n=>(this.Or.set(t,{size:n.size,readTime:n.document.readTime}),n.document)))}getAllFromCache(e,t){return this.Mr.vr(e,t).next((({documents:n,Fr:s})=>(s.forEach(((i,o)=>{this.Or.set(i,{size:o,readTime:n.get(i).readTime})})),n)))}}function ma(r){return te(r,Hn)}function ht(r){return te(r,Br)}function Dn(r){const e=r.path.toArray();return[e.slice(0,e.length-2),e[e.length-2],e[e.length-1]]}function _a(r,e){const t=e.documentKey.path.toArray();return[r,Qr(e.readTime),t.slice(0,t.length-2),t.length>0?t[t.length-1]:""]}function ga(r,e){const t=r.path.toArray(),n=e.path.toArray();let s=0;for(let i=0;i<t.length-2&&i<n.length-2;++i)if(s=P(t[i],n[i]),s)return s;return s=P(t.length,n.length),s||(s=P(t[t.length-2],n[n.length-2]),s||P(t[t.length-1],n[n.length-1]))}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *//**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class jd{constructor(e,t){this.overlayedDocument=e,this.mutatedFields=t}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Sc{constructor(e,t,n,s){this.remoteDocumentCache=e,this.mutationQueue=t,this.documentOverlayCache=n,this.indexManager=s}getDocument(e,t){let n=null;return this.documentOverlayCache.getOverlay(e,t).next((s=>(n=s,this.remoteDocumentCache.getEntry(e,t)))).next((s=>(n!==null&&$n(n.mutation,s,me.empty(),F.now()),s)))}getDocuments(e,t){return this.remoteDocumentCache.getEntries(e,t).next((n=>this.getLocalViewOfDocuments(e,n,C()).next((()=>n))))}getLocalViewOfDocuments(e,t,n=C()){const s=Pe();return this.populateOverlays(e,s,t).next((()=>this.computeViews(e,t,s,n).next((i=>{let o=Fn();return i.forEach(((a,u)=>{o=o.insert(a,u.overlayedDocument)})),o}))))}getOverlayedDocuments(e,t){const n=Pe();return this.populateOverlays(e,n,t).next((()=>this.computeViews(e,t,n,C())))}populateOverlays(e,t,n){const s=[];return n.forEach((i=>{t.has(i)||s.push(i)})),this.documentOverlayCache.getOverlays(e,s).next((i=>{i.forEach(((o,a)=>{t.set(o,a)}))}))}computeViews(e,t,n,s){let i=_e();const o=Gn(),a=(function(){return Gn()})();return t.forEach(((u,c)=>{const l=n.get(c.key);s.has(c.key)&&(l===void 0||l.mutation instanceof Ue)?i=i.insert(c.key,c):l!==void 0?(o.set(c.key,l.mutation.getFieldMask()),$n(l.mutation,c,l.mutation.getFieldMask(),F.now())):o.set(c.key,me.empty())})),this.recalculateAndSaveOverlays(e,i).next((u=>(u.forEach(((c,l)=>o.set(c,l))),t.forEach(((c,l)=>a.set(c,new jd(l,o.get(c)??null)))),a)))}recalculateAndSaveOverlays(e,t){const n=Gn();let s=new U(((o,a)=>o-a)),i=C();return this.mutationQueue.getAllMutationBatchesAffectingDocumentKeys(e,t).next((o=>{for(const a of o)a.keys().forEach((u=>{const c=t.get(u);if(c===null)return;let l=n.get(u)||me.empty();l=a.applyToLocalView(c,l),n.set(u,l);const h=(s.get(a.batchId)||C()).add(u);s=s.insert(a.batchId,h)}))})).next((()=>{const o=[],a=s.getReverseIterator();for(;a.hasNext();){const u=a.getNext(),c=u.key,l=u.value,h=Gu();l.forEach((d=>{if(!i.has(d)){const _=Ju(t.get(d),n.get(d));_!==null&&h.set(d,_),i=i.add(d)}})),o.push(this.documentOverlayCache.saveOverlays(e,c,h))}return f.waitFor(o)})).next((()=>n))}recalculateAndSaveOverlaysForDocumentKeys(e,t){return this.remoteDocumentCache.getEntries(e,t).next((n=>this.recalculateAndSaveOverlays(e,n)))}getDocumentsMatchingQuery(e,t,n,s){return Zh(t)?this.getDocumentsMatchingDocumentQuery(e,t.path):wi(t)?this.getDocumentsMatchingCollectionGroupQuery(e,t,n,s):this.getDocumentsMatchingCollectionQuery(e,t,n,s)}getNextDocuments(e,t,n,s){return this.remoteDocumentCache.getAllFromCollectionGroup(e,t,n,s).next((i=>{const o=s-i.size>0?this.documentOverlayCache.getOverlaysForCollectionGroup(e,t,n.largestBatchId,s-i.size):f.resolve(Pe());let a=Xt,u=i;return o.next((c=>f.forEach(c,((l,h)=>(a<h.largestBatchId&&(a=h.largestBatchId),i.get(l)?f.resolve():this.remoteDocumentCache.getEntry(e,l).next((d=>{u=u.insert(l,d)}))))).next((()=>this.populateOverlays(e,c,i))).next((()=>this.computeViews(e,u,c,C()))).next((l=>({batchId:a,changes:zu(l)})))))}))}getDocumentsMatchingDocumentQuery(e,t){return this.getDocument(e,new E(t)).next((n=>{let s=Fn();return n.isFoundDocument()&&(s=s.insert(n.key,n)),s}))}getDocumentsMatchingCollectionGroupQuery(e,t,n,s){const i=t.collectionGroup;let o=Fn();return this.indexManager.getCollectionParents(e,i).next((a=>f.forEach(a,(u=>{const c=(function(h,d){return new Le(d,null,h.explicitOrderBy.slice(),h.filters.slice(),h.limit,h.limitType,h.startAt,h.endAt)})(t,u.child(i));return this.getDocumentsMatchingCollectionQuery(e,c,n,s).next((l=>{l.forEach(((h,d)=>{o=o.insert(h,d)}))}))})).next((()=>o))))}getDocumentsMatchingCollectionQuery(e,t,n,s){let i;return this.documentOverlayCache.getOverlaysForCollection(e,t.path,n.largestBatchId).next((o=>(i=o,this.remoteDocumentCache.getDocumentsMatchingQuery(e,t,n,i,s)))).next((o=>{i.forEach(((u,c)=>{const l=c.getKey();o.get(l)===null&&(o=o.insert(l,B.newInvalidDocument(l)))}));let a=Fn();return o.forEach(((u,c)=>{const l=i.get(u);l!==void 0&&$n(l.mutation,c,me.empty(),F.now()),hr(t,c)&&(a=a.insert(u,c))})),a}))}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Wd{constructor(e){this.serializer=e,this.Nr=new Map,this.Br=new Map}getBundleMetadata(e,t){return f.resolve(this.Nr.get(t))}saveBundleMetadata(e,t){return this.Nr.set(t.id,(function(s){return{id:s.id,version:s.version,createTime:J(s.createTime)}})(t)),f.resolve()}getNamedQuery(e,t){return f.resolve(this.Br.get(t))}saveNamedQuery(e,t){return this.Br.set(t.name,(function(s){return{name:s.name,query:fs(s.bundledQuery),readTime:J(s.readTime)}})(t)),f.resolve()}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Hd{constructor(){this.overlays=new U(E.comparator),this.Lr=new Map}getOverlay(e,t){return f.resolve(this.overlays.get(t))}getOverlays(e,t){const n=Pe();return f.forEach(t,(s=>this.getOverlay(e,s).next((i=>{i!==null&&n.set(s,i)})))).next((()=>n))}saveOverlays(e,t,n){return n.forEach(((s,i)=>{this.bt(e,t,i)})),f.resolve()}removeOverlaysForBatchId(e,t,n){const s=this.Lr.get(n);return s!==void 0&&(s.forEach((i=>this.overlays=this.overlays.remove(i))),this.Lr.delete(n)),f.resolve()}getOverlaysForCollection(e,t,n){const s=Pe(),i=t.length+1,o=new E(t.child("")),a=this.overlays.getIteratorFrom(o);for(;a.hasNext();){const u=a.getNext().value,c=u.getKey();if(!t.isPrefixOf(c.path))break;c.path.length===i&&u.largestBatchId>n&&s.set(u.getKey(),u)}return f.resolve(s)}getOverlaysForCollectionGroup(e,t,n,s){let i=new U(((c,l)=>c-l));const o=this.overlays.getIterator();for(;o.hasNext();){const c=o.getNext().value;if(c.getKey().getCollectionGroup()===t&&c.largestBatchId>n){let l=i.get(c.largestBatchId);l===null&&(l=Pe(),i=i.insert(c.largestBatchId,l)),l.set(c.getKey(),c)}}const a=Pe(),u=i.getIterator();for(;u.hasNext()&&(u.getNext().value.forEach(((c,l)=>a.set(c,l))),!(a.size()>=s)););return f.resolve(a)}bt(e,t,n){const s=this.overlays.get(n.key);if(s!==null){const o=this.Lr.get(s.largestBatchId).delete(n.key);this.Lr.set(s.largestBatchId,o)}this.overlays=this.overlays.insert(n.key,new bi(t,n));let i=this.Lr.get(t);i===void 0&&(i=C(),this.Lr.set(t,i)),this.Lr.set(t,i.add(n.key))}}/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Jd{constructor(){this.sessionToken=W.EMPTY_BYTE_STRING}getSessionToken(e){return f.resolve(this.sessionToken)}setSessionToken(e,t){return this.sessionToken=t,f.resolve()}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ni{constructor(){this.kr=new O(ne.Kr),this.qr=new O(ne.Ur)}isEmpty(){return this.kr.isEmpty()}addReference(e,t){const n=new ne(e,t);this.kr=this.kr.add(n),this.qr=this.qr.add(n)}$r(e,t){e.forEach((n=>this.addReference(n,t)))}removeReference(e,t){this.Wr(new ne(e,t))}Qr(e,t){e.forEach((n=>this.removeReference(n,t)))}Gr(e){const t=new E(new x([])),n=new ne(t,e),s=new ne(t,e+1),i=[];return this.qr.forEachInRange([n,s],(o=>{this.Wr(o),i.push(o.key)})),i}zr(){this.kr.forEach((e=>this.Wr(e)))}Wr(e){this.kr=this.kr.delete(e),this.qr=this.qr.delete(e)}jr(e){const t=new E(new x([])),n=new ne(t,e),s=new ne(t,e+1);let i=C();return this.qr.forEachInRange([n,s],(o=>{i=i.add(o.key)})),i}containsKey(e){const t=new ne(e,0),n=this.kr.firstAfterOrEqual(t);return n!==null&&e.isEqual(n.key)}}class ne{constructor(e,t){this.key=e,this.Hr=t}static Kr(e,t){return E.comparator(e.key,t.key)||P(e.Hr,t.Hr)}static Ur(e,t){return P(e.Hr,t.Hr)||E.comparator(e.key,t.key)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Yd{constructor(e,t){this.indexManager=e,this.referenceDelegate=t,this.mutationQueue=[],this.Yn=1,this.Jr=new O(ne.Kr)}checkEmpty(e){return f.resolve(this.mutationQueue.length===0)}addMutationBatch(e,t,n,s){const i=this.Yn;this.Yn++,this.mutationQueue.length>0&&this.mutationQueue[this.mutationQueue.length-1];const o=new Vi(i,t,n,s);this.mutationQueue.push(o);for(const a of s)this.Jr=this.Jr.add(new ne(a.key,i)),this.indexManager.addToCollectionParentIndex(e,a.key.path.popLast());return f.resolve(o)}lookupMutationBatch(e,t){return f.resolve(this.Zr(t))}getNextMutationBatchAfterBatchId(e,t){const n=t+1,s=this.Xr(n),i=s<0?0:s;return f.resolve(this.mutationQueue.length>i?this.mutationQueue[i]:null)}getHighestUnacknowledgedBatchId(){return f.resolve(this.mutationQueue.length===0?Ye:this.Yn-1)}getAllMutationBatches(e){return f.resolve(this.mutationQueue.slice())}getAllMutationBatchesAffectingDocumentKey(e,t){const n=new ne(t,0),s=new ne(t,Number.POSITIVE_INFINITY),i=[];return this.Jr.forEachInRange([n,s],(o=>{const a=this.Zr(o.Hr);i.push(a)})),f.resolve(i)}getAllMutationBatchesAffectingDocumentKeys(e,t){let n=new O(P);return t.forEach((s=>{const i=new ne(s,0),o=new ne(s,Number.POSITIVE_INFINITY);this.Jr.forEachInRange([i,o],(a=>{n=n.add(a.Hr)}))})),f.resolve(this.Yr(n))}getAllMutationBatchesAffectingQuery(e,t){const n=t.path,s=n.length+1;let i=n;E.isDocumentKey(i)||(i=i.child(""));const o=new ne(new E(i),0);let a=new O(P);return this.Jr.forEachWhile((u=>{const c=u.key.path;return!!n.isPrefixOf(c)&&(c.length===s&&(a=a.add(u.Hr)),!0)}),o),f.resolve(this.Yr(a))}Yr(e){const t=[];return e.forEach((n=>{const s=this.Zr(n);s!==null&&t.push(s)})),t}removeMutationBatch(e,t){v(this.ei(t.batchId,"removed")===0,55003),this.mutationQueue.shift();let n=this.Jr;return f.forEach(t.mutations,(s=>{const i=new ne(s.key,t.batchId);return n=n.delete(i),this.referenceDelegate.markPotentiallyOrphaned(e,s.key)})).next((()=>{this.Jr=n}))}nr(e){}containsKey(e,t){const n=new ne(t,0),s=this.Jr.firstAfterOrEqual(n);return f.resolve(t.isEqual(s&&s.key))}performConsistencyCheck(e){return this.mutationQueue.length,f.resolve()}ei(e,t){return this.Xr(e)}Xr(e){return this.mutationQueue.length===0?0:e-this.mutationQueue[0].batchId}Zr(e){const t=this.Xr(e);return t<0||t>=this.mutationQueue.length?null:this.mutationQueue[t]}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Xd{constructor(e){this.ti=e,this.docs=(function(){return new U(E.comparator)})(),this.size=0}setIndexManager(e){this.indexManager=e}addEntry(e,t){const n=t.key,s=this.docs.get(n),i=s?s.size:0,o=this.ti(t);return this.docs=this.docs.insert(n,{document:t.mutableCopy(),size:o}),this.size+=o-i,this.indexManager.addToCollectionParentIndex(e,n.path.popLast())}removeEntry(e){const t=this.docs.get(e);t&&(this.docs=this.docs.remove(e),this.size-=t.size)}getEntry(e,t){const n=this.docs.get(t);return f.resolve(n?n.document.mutableCopy():B.newInvalidDocument(t))}getEntries(e,t){let n=_e();return t.forEach((s=>{const i=this.docs.get(s);n=n.insert(s,i?i.document.mutableCopy():B.newInvalidDocument(s))})),f.resolve(n)}getDocumentsMatchingQuery(e,t,n,s){let i=_e();const o=t.path,a=new E(o.child("__id-9223372036854775808__")),u=this.docs.getIteratorFrom(a);for(;u.hasNext();){const{key:c,value:{document:l}}=u.getNext();if(!o.isPrefixOf(c.path))break;c.path.length>o.length+1||fi(nu(l),n)<=0||(s.has(l.key)||hr(t,l))&&(i=i.insert(l.key,l.mutableCopy()))}return f.resolve(i)}getAllFromCollectionGroup(e,t,n,s){A(9500)}ni(e,t){return f.forEach(this.docs,(n=>t(n)))}newChangeBuffer(e){return new Zd(this)}getSize(e){return f.resolve(this.size)}}class Zd extends Pc{constructor(e){super(),this.Mr=e}applyChanges(e){const t=[];return this.changes.forEach(((n,s)=>{s.isValidDocument()?t.push(this.Mr.addEntry(e,s)):this.Mr.removeEntry(n)})),f.waitFor(t)}getFromCache(e,t){return this.Mr.getEntry(e,t)}getAllFromCache(e,t){return this.Mr.getEntries(e,t)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ef{constructor(e){this.persistence=e,this.ri=new qe((t=>Rt(t)),cr),this.lastRemoteSnapshotVersion=R.min(),this.highestTargetId=0,this.ii=0,this.si=new Ni,this.targetCount=0,this.oi=Ct._r()}forEachTarget(e,t){return this.ri.forEach(((n,s)=>t(s))),f.resolve()}getLastRemoteSnapshotVersion(e){return f.resolve(this.lastRemoteSnapshotVersion)}getHighestSequenceNumber(e){return f.resolve(this.ii)}allocateTargetId(e){return this.highestTargetId=this.oi.next(),f.resolve(this.highestTargetId)}setTargetsMetadata(e,t,n){return n&&(this.lastRemoteSnapshotVersion=n),t>this.ii&&(this.ii=t),f.resolve()}lr(e){this.ri.set(e.target,e);const t=e.targetId;t>this.highestTargetId&&(this.oi=new Ct(t),this.highestTargetId=t),e.sequenceNumber>this.ii&&(this.ii=e.sequenceNumber)}addTargetData(e,t){return this.lr(t),this.targetCount+=1,f.resolve()}updateTargetData(e,t){return this.lr(t),f.resolve()}removeTargetData(e,t){return this.ri.delete(t.target),this.si.Gr(t.targetId),this.targetCount-=1,f.resolve()}removeTargets(e,t,n){let s=0;const i=[];return this.ri.forEach(((o,a)=>{a.sequenceNumber<=t&&n.get(a.targetId)===null&&(this.ri.delete(o),i.push(this.removeMatchingKeysForTargetId(e,a.targetId)),s++)})),f.waitFor(i).next((()=>s))}getTargetCount(e){return f.resolve(this.targetCount)}getTargetData(e,t){const n=this.ri.get(t)||null;return f.resolve(n)}addMatchingKeys(e,t,n){return this.si.$r(t,n),f.resolve()}removeMatchingKeys(e,t,n){this.si.Qr(t,n);const s=this.persistence.referenceDelegate,i=[];return s&&t.forEach((o=>{i.push(s.markPotentiallyOrphaned(e,o))})),f.waitFor(i)}removeMatchingKeysForTargetId(e,t){return this.si.Gr(t),f.resolve()}getMatchingKeysForTargetId(e,t){const n=this.si.jr(t);return f.resolve(n)}containsKey(e,t){return f.resolve(this.si.containsKey(t))}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ki{constructor(e,t){this._i={},this.overlays={},this.ai=new fe(0),this.ui=!1,this.ui=!0,this.ci=new Jd,this.referenceDelegate=e(this),this.li=new ef(this),this.indexManager=new qd,this.remoteDocumentCache=(function(s){return new Xd(s)})((n=>this.referenceDelegate.hi(n))),this.serializer=new gc(t),this.Pi=new Wd(this.serializer)}start(){return Promise.resolve()}shutdown(){return this.ui=!1,Promise.resolve()}get started(){return this.ui}setDatabaseDeletedListener(){}setNetworkEnabled(){}getIndexManager(e){return this.indexManager}getDocumentOverlayCache(e){let t=this.overlays[e.toKey()];return t||(t=new Hd,this.overlays[e.toKey()]=t),t}getMutationQueue(e,t){let n=this._i[e.toKey()];return n||(n=new Yd(t,this.referenceDelegate),this._i[e.toKey()]=n),n}getGlobalsCache(){return this.ci}getTargetCache(){return this.li}getRemoteDocumentCache(){return this.remoteDocumentCache}getBundleCache(){return this.Pi}runTransaction(e,t,n){p("MemoryPersistence","Starting transaction:",e);const s=new tf(this.ai.next());return this.referenceDelegate.Ti(),n(s).next((i=>this.referenceDelegate.Ii(s).next((()=>i)))).toPromise().then((i=>(s.raiseOnCommittedEvent(),i)))}Ei(e,t){return f.or(Object.values(this._i).map((n=>()=>n.containsKey(e,t))))}}class tf extends su{constructor(e){super(),this.currentSequenceNumber=e}}class gs{constructor(e){this.persistence=e,this.Ri=new Ni,this.Ai=null}static Vi(e){return new gs(e)}get di(){if(this.Ai)return this.Ai;throw A(60996)}addReference(e,t,n){return this.Ri.addReference(n,t),this.di.delete(n.toString()),f.resolve()}removeReference(e,t,n){return this.Ri.removeReference(n,t),this.di.add(n.toString()),f.resolve()}markPotentiallyOrphaned(e,t){return this.di.add(t.toString()),f.resolve()}removeTarget(e,t){this.Ri.Gr(t.targetId).forEach((s=>this.di.add(s.toString())));const n=this.persistence.getTargetCache();return n.getMatchingKeysForTargetId(e,t.targetId).next((s=>{s.forEach((i=>this.di.add(i.toString())))})).next((()=>n.removeTargetData(e,t)))}Ti(){this.Ai=new Set}Ii(e){const t=this.persistence.getRemoteDocumentCache().newChangeBuffer();return f.forEach(this.di,(n=>{const s=E.fromPath(n);return this.mi(e,s).next((i=>{i||t.removeEntry(s,R.min())}))})).next((()=>(this.Ai=null,t.apply(e))))}updateLimboDocument(e,t){return this.mi(e,t).next((n=>{n?this.di.delete(t.toString()):this.di.add(t.toString())}))}hi(e){return 0}mi(e,t){return f.or([()=>f.resolve(this.Ri.containsKey(t)),()=>this.persistence.getTargetCache().containsKey(e,t),()=>this.persistence.Ei(e,t)])}}class Hr{constructor(e,t){this.persistence=e,this.fi=new qe((n=>le(n.path)),((n,s)=>n.isEqual(s))),this.garbageCollector=Vc(this,t)}static Vi(e,t){return new Hr(e,t)}Ti(){}Ii(e){return f.resolve()}forEachTarget(e,t){return this.persistence.getTargetCache().forEachTarget(e,t)}dr(e){const t=this.pr(e);return this.persistence.getTargetCache().getTargetCount(e).next((n=>t.next((s=>n+s))))}pr(e){let t=0;return this.mr(e,(n=>{t++})).next((()=>t))}mr(e,t){return f.forEach(this.fi,((n,s)=>this.wr(e,n,s).next((i=>i?f.resolve():t(s)))))}removeTargets(e,t,n){return this.persistence.getTargetCache().removeTargets(e,t,n)}removeOrphanedDocuments(e,t){let n=0;const s=this.persistence.getRemoteDocumentCache(),i=s.newChangeBuffer();return s.ni(e,(o=>this.wr(e,o,t).next((a=>{a||(n++,i.removeEntry(o,R.min()))})))).next((()=>i.apply(e))).next((()=>n))}markPotentiallyOrphaned(e,t){return this.fi.set(t,e.currentSequenceNumber),f.resolve()}removeTarget(e,t){const n=t.withSequenceNumber(e.currentSequenceNumber);return this.persistence.getTargetCache().updateTargetData(e,n)}addReference(e,t,n){return this.fi.set(n,e.currentSequenceNumber),f.resolve()}removeReference(e,t,n){return this.fi.set(n,e.currentSequenceNumber),f.resolve()}updateLimboDocument(e,t){return this.fi.set(t,e.currentSequenceNumber),f.resolve()}hi(e){let t=e.key.toString().length;return e.isFoundDocument()&&(t+=Dr(e.data.value)),t}wr(e,t,n){return f.or([()=>this.persistence.Ei(e,t),()=>this.persistence.getTargetCache().containsKey(e,t),()=>{const s=this.fi.get(t);return f.resolve(s!==void 0&&s>n)}])}getCacheSize(e){return this.persistence.getRemoteDocumentCache().getSize(e)}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class nf{constructor(e){this.serializer=e}k(e,t,n,s){const i=new ns("createOrUpgrade",t);n<1&&s>=1&&((function(u){u.createObjectStore(ur)})(e),(function(u){u.createObjectStore(Wn,{keyPath:_h}),u.createObjectStore(Ae,{keyPath:Po,autoIncrement:!0}).createIndex(yt,bo,{unique:!0}),u.createObjectStore(tn)})(e),pa(e),(function(u){u.createObjectStore(ft)})(e));let o=f.resolve();return n<3&&s>=3&&(n!==0&&((function(u){u.deleteObjectStore(rn),u.deleteObjectStore(nn),u.deleteObjectStore(Et)})(e),pa(e)),o=o.next((()=>(function(u){const c=u.store(Et),l={highestTargetId:0,highestListenSequenceNumber:0,lastRemoteSnapshotVersion:R.min().toTimestamp(),targetCount:0};return c.put(zr,l)})(i)))),n<4&&s>=4&&(n!==0&&(o=o.next((()=>(function(u,c){return c.store(Ae).H().next((h=>{u.deleteObjectStore(Ae),u.createObjectStore(Ae,{keyPath:Po,autoIncrement:!0}).createIndex(yt,bo,{unique:!0});const d=c.store(Ae),_=h.map((y=>d.put(y)));return f.waitFor(_)}))})(e,i)))),o=o.next((()=>{(function(u){u.createObjectStore(sn,{keyPath:vh})})(e)}))),n<5&&s>=5&&(o=o.next((()=>this.gi(i)))),n<6&&s>=6&&(o=o.next((()=>((function(u){u.createObjectStore(Hn)})(e),this.pi(i))))),n<7&&s>=7&&(o=o.next((()=>this.yi(i)))),n<8&&s>=8&&(o=o.next((()=>this.wi(e,i)))),n<9&&s>=9&&(o=o.next((()=>{(function(u){u.objectStoreNames.contains("remoteDocumentChanges")&&u.deleteObjectStore("remoteDocumentChanges")})(e)}))),n<10&&s>=10&&(o=o.next((()=>this.bi(i)))),n<11&&s>=11&&(o=o.next((()=>{(function(u){u.createObjectStore(rs,{keyPath:Rh})})(e),(function(u){u.createObjectStore(ss,{keyPath:Vh})})(e)}))),n<12&&s>=12&&(o=o.next((()=>{(function(u){const c=u.createObjectStore(is,{keyPath:Nh});c.createIndex(Gs,kh,{unique:!1}),c.createIndex(du,Fh,{unique:!1})})(e)}))),n<13&&s>=13&&(o=o.next((()=>(function(u){const c=u.createObjectStore(Br,{keyPath:ph});c.createIndex(Cr,yh),c.createIndex(uu,Ih)})(e))).next((()=>this.Si(e,i))).next((()=>e.deleteObjectStore(ft)))),n<14&&s>=14&&(o=o.next((()=>this.Di(e,i)))),n<15&&s>=15&&(o=o.next((()=>(function(u){u.createObjectStore(gi,{keyPath:Ph,autoIncrement:!0}).createIndex(zs,bh,{unique:!1}),u.createObjectStore(Un,{keyPath:Sh}).createIndex(lu,Ch,{unique:!1}),u.createObjectStore(Bn,{keyPath:xh}).createIndex(hu,Dh,{unique:!1})})(e)))),n<16&&s>=16&&(o=o.next((()=>{t.objectStore(Un).clear()})).next((()=>{t.objectStore(Bn).clear()}))),n<17&&s>=17&&(o=o.next((()=>{(function(u){u.createObjectStore(pi,{keyPath:Mh})})(e)}))),n<18&&s>=18&&Ha()&&(o=o.next((()=>{t.objectStore(Un).clear()})).next((()=>{t.objectStore(Bn).clear()}))),o}pi(e){let t=0;return e.store(ft).ee(((n,s)=>{t+=Wr(s)})).next((()=>{const n={byteSize:t};return e.store(Hn).put(Bs,n)}))}gi(e){const t=e.store(Wn),n=e.store(Ae);return t.H().next((s=>f.forEach(s,(i=>{const o=IDBKeyRange.bound([i.userId,Ye],[i.userId,i.lastAcknowledgedBatchId]);return n.H(yt,o).next((a=>f.forEach(a,(u=>{v(u.userId===i.userId,18650,"Cannot process batch from unexpected user",{batchId:u.batchId});const c=_t(this.serializer,u);return Ec(e,i.userId,c).next((()=>{}))}))))}))))}yi(e){const t=e.store(rn),n=e.store(ft);return e.store(Et).get(zr).next((s=>{const i=[];return n.ee(((o,a)=>{const u=new x(o),c=(function(h){return[0,le(h)]})(u);i.push(t.get(c).next((l=>l?f.resolve():(h=>t.put({targetId:0,path:le(h),sequenceNumber:s.highestListenSequenceNumber}))(u))))})).next((()=>f.waitFor(i)))}))}wi(e,t){e.createObjectStore(Jn,{keyPath:Ah});const n=t.store(Jn),s=new Di,i=o=>{if(s.add(o)){const a=o.lastSegment(),u=o.popLast();return n.put({collectionId:a,parent:le(u)})}};return t.store(ft).ee({Y:!0},((o,a)=>{const u=new x(o);return i(u.popLast())})).next((()=>t.store(tn).ee({Y:!0},(([o,a,u],c)=>{const l=Ve(a);return i(l.popLast())}))))}bi(e){const t=e.store(nn);return t.ee(((n,s)=>{const i=On(s),o=pc(this.serializer,i);return t.put(o)}))}Si(e,t){const n=t.store(ft),s=[];return n.ee(((i,o)=>{const a=t.store(Br),u=(function(h){return h.document?new E(x.fromString(h.document.name).popFirst(5)):h.noDocument?E.fromSegments(h.noDocument.path):h.unknownDocument?E.fromSegments(h.unknownDocument.path):A(36783)})(o).path.toArray(),c={prefixPath:u.slice(0,u.length-2),collectionGroup:u[u.length-2],documentId:u[u.length-1],readTime:o.readTime||[0,0],unknownDocument:o.unknownDocument,noDocument:o.noDocument,document:o.document,hasCommittedMutations:!!o.hasCommittedMutations};s.push(a.put(c))})).next((()=>f.waitFor(s)))}Di(e,t){const n=t.store(Ae),s=bc(this.serializer),i=new ki(gs.Vi,this.serializer.yt);return n.H().next((o=>{const a=new Map;return o.forEach((u=>{let c=a.get(u.userId)??C();_t(this.serializer,u).keys().forEach((l=>c=c.add(l))),a.set(u.userId,c)})),f.forEach(a,((u,c)=>{const l=new re(c),h=ms.wt(this.serializer,l),d=i.getIndexManager(l),_=_s.wt(l,this.serializer,d,i.referenceDelegate);return new Sc(s,_,h,d).recalculateAndSaveOverlaysForDocumentKeys(new $s(t,fe.ce),u).next()}))}))}}function pa(r){r.createObjectStore(rn,{keyPath:Eh}).createIndex(_i,wh,{unique:!0}),r.createObjectStore(nn,{keyPath:"targetId"}).createIndex(cu,Th,{unique:!0}),r.createObjectStore(Et)}const Ke="IndexedDbPersistence",Cs=18e5,xs=5e3,Ds="Failed to obtain exclusive access to the persistence layer. To allow shared access, multi-tab synchronization has to be enabled in all tabs. If you are using `experimentalForceOwningTab:true`, make sure that only one tab has persistence enabled at any given time.",Cc="main";class Fi{constructor(e,t,n,s,i,o,a,u,c,l,h=18){if(this.allowTabSynchronization=e,this.persistenceKey=t,this.clientId=n,this.Ci=i,this.window=o,this.document=a,this.Fi=c,this.Mi=l,this.xi=h,this.ai=null,this.ui=!1,this.isPrimary=!1,this.networkEnabled=!0,this.Oi=null,this.inForeground=!1,this.Ni=null,this.Bi=null,this.Li=Number.NEGATIVE_INFINITY,this.ki=d=>Promise.resolve(),!Fi.v())throw new g(m.UNIMPLEMENTED,"This platform is either missing IndexedDB or is known to have an incomplete implementation. Offline persistence has been disabled.");this.referenceDelegate=new $d(this,s),this.Ki=t+Cc,this.serializer=new gc(u),this.qi=new be(this.Ki,this.xi,new nf(this.serializer)),this.ci=new Nd,this.li=new Bd(this.referenceDelegate,this.serializer),this.remoteDocumentCache=bc(this.serializer),this.Pi=new Dd,this.window&&this.window.localStorage?this.Ui=this.window.localStorage:(this.Ui=null,l===!1&&H(Ke,"LocalStorage is unavailable. As a result, persistence may not work reliably. In particular enablePersistence() could fail immediately after refreshing the page."))}start(){return this.$i().then((()=>{if(!this.isPrimary&&!this.allowTabSynchronization)throw new g(m.FAILED_PRECONDITION,Ds);return this.Wi(),this.Qi(),this.Gi(),this.runTransaction("getHighestListenSequenceNumber","readonly",(e=>this.li.getHighestSequenceNumber(e)))})).then((e=>{this.ai=new fe(e,this.Fi)})).then((()=>{this.ui=!0})).catch((e=>(this.qi&&this.qi.close(),Promise.reject(e))))}zi(e){return this.ki=async t=>{if(this.started)return e(t)},e(this.isPrimary)}setDatabaseDeletedListener(e){this.qi.q((async t=>{t.newVersion===null&&await e()}))}setNetworkEnabled(e){this.networkEnabled!==e&&(this.networkEnabled=e,this.Ci.enqueueAndForget((async()=>{this.started&&await this.$i()})))}$i(){return this.runTransaction("updateClientMetadataAndTryBecomePrimary","readwrite",(e=>Vr(e).put({clientId:this.clientId,updateTimeMs:Date.now(),networkEnabled:this.networkEnabled,inForeground:this.inForeground}).next((()=>{if(this.isPrimary)return this.ji(e).next((t=>{t||(this.isPrimary=!1,this.Ci.enqueueRetryable((()=>this.ki(!1))))}))})).next((()=>this.Hi(e))).next((t=>this.isPrimary&&!t?this.Ji(e).next((()=>!1)):!!t&&this.Zi(e).next((()=>!0)))))).catch((e=>{if(ot(e))return p(Ke,"Failed to extend owner lease: ",e),this.isPrimary;if(!this.allowTabSynchronization)throw e;return p(Ke,"Releasing owner lease after error during lease refresh",e),!1})).then((e=>{this.isPrimary!==e&&this.Ci.enqueueRetryable((()=>this.ki(e))),this.isPrimary=e}))}ji(e){return Nn(e).get(Lt).next((t=>f.resolve(this.Xi(t))))}Yi(e){return Vr(e).delete(this.clientId)}async es(){if(this.isPrimary&&!this.ts(this.Li,Cs)){this.Li=Date.now();const e=await this.runTransaction("maybeGarbageCollectMultiClientState","readwrite-primary",(t=>{const n=te(t,sn);return n.H().next((s=>{const i=this.ns(s,Cs),o=s.filter((a=>i.indexOf(a)===-1));return f.forEach(o,(a=>n.delete(a.clientId))).next((()=>o))}))})).catch((()=>[]));if(this.Ui)for(const t of e)this.Ui.removeItem(this.rs(t.clientId))}}Gi(){this.Bi=this.Ci.enqueueAfterDelay("client_metadata_refresh",4e3,(()=>this.$i().then((()=>this.es())).then((()=>this.Gi()))))}Xi(e){return!!e&&e.ownerId===this.clientId}Hi(e){return this.Mi?f.resolve(!0):Nn(e).get(Lt).next((t=>{if(t!==null&&this.ts(t.leaseTimestampMs,xs)&&!this.ss(t.ownerId)){if(this.Xi(t)&&this.networkEnabled)return!0;if(!this.Xi(t)){if(!t.allowTabSynchronization)throw new g(m.FAILED_PRECONDITION,Ds);return!1}}return!(!this.networkEnabled||!this.inForeground)||Vr(e).H().next((n=>this.ns(n,xs).find((s=>{if(this.clientId!==s.clientId){const i=!this.networkEnabled&&s.networkEnabled,o=!this.inForeground&&s.inForeground,a=this.networkEnabled===s.networkEnabled;if(i||o&&a)return!0}return!1}))===void 0))})).next((t=>(this.isPrimary!==t&&p(Ke,`Client ${t?"is":"is not"} eligible for a primary lease.`),t)))}async shutdown(){this.ui=!1,this._s(),this.Bi&&(this.Bi.cancel(),this.Bi=null),this.us(),this.cs(),await this.qi.runTransaction("shutdown","readwrite",[ur,sn],(e=>{const t=new $s(e,fe.ce);return this.Ji(t).next((()=>this.Yi(t)))})),this.qi.close(),this.ls()}ns(e,t){return e.filter((n=>this.ts(n.updateTimeMs,t)&&!this.ss(n.clientId)))}hs(){return this.runTransaction("getActiveClients","readonly",(e=>Vr(e).H().next((t=>this.ns(t,Cs).map((n=>n.clientId))))))}get started(){return this.ui}getGlobalsCache(){return this.ci}getMutationQueue(e,t){return _s.wt(e,this.serializer,t,this.referenceDelegate)}getTargetCache(){return this.li}getRemoteDocumentCache(){return this.remoteDocumentCache}getIndexManager(e){return new Ud(e,this.serializer.yt.databaseId)}getDocumentOverlayCache(e){return ms.wt(this.serializer,e)}getBundleCache(){return this.Pi}runTransaction(e,t,n){p(Ke,"Starting transaction:",e);const s=t==="readonly"?"readonly":"readwrite",i=(function(u){return u===18?qh:u===17?gu:u===16?Lh:u===15?yi:u===14?_u:u===13?mu:u===12?Oh:u===11?fu:void A(60245)})(this.xi);let o;return this.qi.runTransaction(e,s,i,(a=>(o=new $s(a,this.ai?this.ai.next():fe.ce),t==="readwrite-primary"?this.ji(o).next((u=>!!u||this.Hi(o))).next((u=>{if(!u)throw H(`Failed to obtain primary lease for action '${e}'.`),this.isPrimary=!1,this.Ci.enqueueRetryable((()=>this.ki(!1))),new g(m.FAILED_PRECONDITION,ru);return n(o)})).next((u=>this.Zi(o).next((()=>u)))):this.Ps(o).next((()=>n(o)))))).then((a=>(o.raiseOnCommittedEvent(),a)))}Ps(e){return Nn(e).get(Lt).next((t=>{if(t!==null&&this.ts(t.leaseTimestampMs,xs)&&!this.ss(t.ownerId)&&!this.Xi(t)&&!(this.Mi||this.allowTabSynchronization&&t.allowTabSynchronization))throw new g(m.FAILED_PRECONDITION,Ds)}))}Zi(e){const t={ownerId:this.clientId,allowTabSynchronization:this.allowTabSynchronization,leaseTimestampMs:Date.now()};return Nn(e).put(Lt,t)}static v(){return be.v()}Ji(e){const t=Nn(e);return t.get(Lt).next((n=>this.Xi(n)?(p(Ke,"Releasing primary lease."),t.delete(Lt)):f.resolve()))}ts(e,t){const n=Date.now();return!(e<n-t)&&(!(e>n)||(H(`Detected an update time that is in the future: ${e} > ${n}`),!1))}Wi(){this.document!==null&&typeof this.document.addEventListener=="function"&&(this.Ni=()=>{this.Ci.enqueueAndForget((()=>(this.inForeground=this.document.visibilityState==="visible",this.$i())))},this.document.addEventListener("visibilitychange",this.Ni),this.inForeground=this.document.visibilityState==="visible")}us(){this.Ni&&(this.document.removeEventListener("visibilitychange",this.Ni),this.Ni=null)}Qi(){var e;typeof((e=this.window)==null?void 0:e.addEventListener)=="function"&&(this.Oi=()=>{this._s();const t=/(?:Version|Mobile)\/1[456]/;Wa()&&(navigator.appVersion.match(t)||navigator.userAgent.match(t))&&this.Ci.enterRestrictedMode(!0),this.Ci.enqueueAndForget((()=>this.shutdown()))},this.window.addEventListener("pagehide",this.Oi))}cs(){this.Oi&&(this.window.removeEventListener("pagehide",this.Oi),this.Oi=null)}ss(e){var t;try{const n=((t=this.Ui)==null?void 0:t.getItem(this.rs(e)))!==null;return p(Ke,`Client '${e}' ${n?"is":"is not"} zombied in LocalStorage`),n}catch(n){return H(Ke,"Failed to get zombied client id.",n),!1}}_s(){if(this.Ui)try{this.Ui.setItem(this.rs(this.clientId),String(Date.now()))}catch(e){H("Failed to set zombie client id.",e)}}ls(){if(this.Ui)try{this.Ui.removeItem(this.rs(this.clientId))}catch{}}rs(e){return`firestore_zombie_${this.persistenceKey}_${e}`}}function Nn(r){return te(r,ur)}function Vr(r){return te(r,sn)}function Mi(r,e){let t=r.projectId;return r.isDefaultDatabase||(t+="."+r.database),"firestore/"+e+"/"+t+"/"}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Oi{constructor(e,t,n,s){this.targetId=e,this.fromCache=t,this.Ts=n,this.Is=s}static Es(e,t){let n=C(),s=C();for(const i of t.docChanges)switch(i.type){case 0:n=n.add(i.doc.key);break;case 1:s=s.add(i.doc.key)}return new Oi(e,t.fromCache,n,s)}}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class rf{constructor(){this._documentReadCount=0}get documentReadCount(){return this._documentReadCount}incrementDocumentReadCount(e){this._documentReadCount+=e}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class xc{constructor(){this.Rs=!1,this.As=!1,this.Vs=100,this.ds=(function(){return Wa()?8:iu(qr())>0?6:4})()}initialize(e,t){this.fs=e,this.indexManager=t,this.Rs=!0}getDocumentsMatchingQuery(e,t,n,s){const i={result:null};return this.gs(e,t).next((o=>{i.result=o})).next((()=>{if(!i.result)return this.ps(e,t,s,n).next((o=>{i.result=o}))})).next((()=>{if(i.result)return;const o=new rf;return this.ys(e,t,o).next((a=>{if(i.result=a,this.As)return this.ws(e,t,o,a.size)}))})).next((()=>i.result))}ws(e,t,n,s){return n.documentReadCount<this.Vs?($t()<=Ne.DEBUG&&p("QueryEngine","SDK will not create cache indexes for query:",Kt(t),"since it only creates cache indexes for collection contains","more than or equal to",this.Vs,"documents"),f.resolve()):($t()<=Ne.DEBUG&&p("QueryEngine","Query:",Kt(t),"scans",n.documentReadCount,"local documents and returns",s,"documents as results."),n.documentReadCount>this.ds*s?($t()<=Ne.DEBUG&&p("QueryEngine","The SDK decides to create cache indexes for query:",Kt(t),"as using cache indexes may help improve performance."),this.indexManager.createTargetIndexes(e,he(t))):f.resolve())}gs(e,t){if(Bo(t))return f.resolve(null);let n=he(t);return this.indexManager.getIndexType(e,n).next((s=>s===0?null:(t.limit!==null&&s===1&&(t=Kr(t,null,"F"),n=he(t)),this.indexManager.getDocumentsMatchingTarget(e,n).next((i=>{const o=C(...i);return this.fs.getDocuments(e,o).next((a=>this.indexManager.getMinOffset(e,n).next((u=>{const c=this.bs(t,a);return this.Ss(t,c,o,u.readTime)?this.gs(e,Kr(t,null,"F")):this.Ds(e,c,t,u)}))))})))))}ps(e,t,n,s){return Bo(t)||s.isEqual(R.min())?f.resolve(null):this.fs.getDocuments(e,n).next((i=>{const o=this.bs(t,i);return this.Ss(t,o,n,s)?f.resolve(null):($t()<=Ne.DEBUG&&p("QueryEngine","Re-using previous result from %s to execute query: %s",s.toString(),Kt(t)),this.Ds(e,o,t,tu(s,Xt)).next((a=>a)))}))}bs(e,t){let n=new O(Uu(e));return t.forEach(((s,i)=>{hr(e,i)&&(n=n.add(i))})),n}Ss(e,t,n,s){if(e.limit===null)return!1;if(n.size!==t.size)return!0;const i=e.limitType==="F"?t.last():t.first();return!!i&&(i.hasPendingWrites||i.version.compareTo(s)>0)}ys(e,t,n){return $t()<=Ne.DEBUG&&p("QueryEngine","Using full collection scan to execute query:",Kt(t)),this.fs.getDocumentsMatchingQuery(e,t,Ee.min(),n)}Ds(e,t,n,s){return this.fs.getDocumentsMatchingQuery(e,n,s).next((i=>(t.forEach((o=>{i=i.insert(o.key,o)})),i)))}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Li="LocalStore",sf=3e8;class of{constructor(e,t,n,s){this.persistence=e,this.Cs=t,this.serializer=s,this.vs=new U(P),this.Fs=new qe((i=>Rt(i)),cr),this.Ms=new Map,this.xs=e.getRemoteDocumentCache(),this.li=e.getTargetCache(),this.Pi=e.getBundleCache(),this.Os(n)}Os(e){this.documentOverlayCache=this.persistence.getDocumentOverlayCache(e),this.indexManager=this.persistence.getIndexManager(e),this.mutationQueue=this.persistence.getMutationQueue(e,this.indexManager),this.localDocuments=new Sc(this.xs,this.mutationQueue,this.documentOverlayCache,this.indexManager),this.xs.setIndexManager(this.indexManager),this.Cs.initialize(this.localDocuments,this.indexManager)}collectGarbage(e){return this.persistence.runTransaction("Collect garbage","readwrite-primary",(t=>e.collect(t,this.vs)))}}function Dc(r,e,t,n){return new of(r,e,t,n)}async function Nc(r,e){const t=w(r);return await t.persistence.runTransaction("Handle user change","readonly",(n=>{let s;return t.mutationQueue.getAllMutationBatches(n).next((i=>(s=i,t.Os(e),t.mutationQueue.getAllMutationBatches(n)))).next((i=>{const o=[],a=[];let u=C();for(const c of s){o.push(c.batchId);for(const l of c.mutations)u=u.add(l.key)}for(const c of i){a.push(c.batchId);for(const l of c.mutations)u=u.add(l.key)}return t.localDocuments.getDocuments(n,u).next((c=>({Ns:c,removedBatchIds:o,addedBatchIds:a})))}))}))}function af(r,e){const t=w(r);return t.persistence.runTransaction("Acknowledge batch","readwrite-primary",(n=>{const s=e.batch.keys(),i=t.xs.newChangeBuffer({trackRemovals:!0});return(function(a,u,c,l){const h=c.batch,d=h.keys();let _=f.resolve();return d.forEach((y=>{_=_.next((()=>l.getEntry(u,y))).next((I=>{const T=c.docVersions.get(y);v(T!==null,48541),I.version.compareTo(T)<0&&(h.applyToRemoteDocument(I,c),I.isValidDocument()&&(I.setReadTime(c.commitVersion),l.addEntry(I)))}))})),_.next((()=>a.mutationQueue.removeMutationBatch(u,h)))})(t,n,e,i).next((()=>i.apply(n))).next((()=>t.mutationQueue.performConsistencyCheck(n))).next((()=>t.documentOverlayCache.removeOverlaysForBatchId(n,s,e.batch.batchId))).next((()=>t.localDocuments.recalculateAndSaveOverlaysForDocumentKeys(n,(function(a){let u=C();for(let c=0;c<a.mutationResults.length;++c)a.mutationResults[c].transformResults.length>0&&(u=u.add(a.batch.mutations[c].key));return u})(e)))).next((()=>t.localDocuments.getDocuments(n,s)))}))}function kc(r){const e=w(r);return e.persistence.runTransaction("Get last remote snapshot version","readonly",(t=>e.li.getLastRemoteSnapshotVersion(t)))}function uf(r,e){const t=w(r),n=e.snapshotVersion;let s=t.vs;return t.persistence.runTransaction("Apply remote event","readwrite-primary",(i=>{const o=t.xs.newChangeBuffer({trackRemovals:!0});s=t.vs;const a=[];e.targetChanges.forEach(((l,h)=>{const d=s.get(h);if(!d)return;a.push(t.li.removeMatchingKeys(i,l.removedDocuments,h).next((()=>t.li.addMatchingKeys(i,l.addedDocuments,h))));let _=d.withSequenceNumber(i.currentSequenceNumber);e.targetMismatches.get(h)!==null?_=_.withResumeToken(W.EMPTY_BYTE_STRING,R.min()).withLastLimboFreeSnapshotVersion(R.min()):l.resumeToken.approximateByteSize()>0&&(_=_.withResumeToken(l.resumeToken,n)),s=s.insert(h,_),(function(I,T,V){return I.resumeToken.approximateByteSize()===0||T.snapshotVersion.toMicroseconds()-I.snapshotVersion.toMicroseconds()>=sf?!0:V.addedDocuments.size+V.modifiedDocuments.size+V.removedDocuments.size>0})(d,_,l)&&a.push(t.li.updateTargetData(i,_))}));let u=_e(),c=C();if(e.documentUpdates.forEach((l=>{e.resolvedLimboDocuments.has(l)&&a.push(t.persistence.referenceDelegate.updateLimboDocument(i,l))})),a.push(Fc(i,o,e.documentUpdates).next((l=>{u=l.Bs,c=l.Ls}))),!n.isEqual(R.min())){const l=t.li.getLastRemoteSnapshotVersion(i).next((h=>t.li.setTargetsMetadata(i,i.currentSequenceNumber,n)));a.push(l)}return f.waitFor(a).next((()=>o.apply(i))).next((()=>t.localDocuments.getLocalViewOfDocuments(i,u,c))).next((()=>u))})).then((i=>(t.vs=s,i)))}function Fc(r,e,t){let n=C(),s=C();return t.forEach((i=>n=n.add(i))),e.getEntries(r,n).next((i=>{let o=_e();return t.forEach(((a,u)=>{const c=i.get(a);u.isFoundDocument()!==c.isFoundDocument()&&(s=s.add(a)),u.isNoDocument()&&u.version.isEqual(R.min())?(e.removeEntry(a,u.readTime),o=o.insert(a,u)):!c.isValidDocument()||u.version.compareTo(c.version)>0||u.version.compareTo(c.version)===0&&c.hasPendingWrites?(e.addEntry(u),o=o.insert(a,u)):p(Li,"Ignoring outdated watch update for ",a,". Current version:",c.version," Watch version:",u.version)})),{Bs:o,Ls:s}}))}function cf(r,e){const t=w(r);return t.persistence.runTransaction("Get next mutation batch","readonly",(n=>(e===void 0&&(e=Ye),t.mutationQueue.getNextMutationBatchAfterBatchId(n,e))))}function dn(r,e){const t=w(r);return t.persistence.runTransaction("Allocate target","readwrite",(n=>{let s;return t.li.getTargetData(n,e).next((i=>i?(s=i,f.resolve(s)):t.li.allocateTargetId(n).next((o=>(s=new ke(e,o,"TargetPurposeListen",n.currentSequenceNumber),t.li.addTargetData(n,s).next((()=>s)))))))})).then((n=>{const s=t.vs.get(n.targetId);return(s===null||n.snapshotVersion.compareTo(s.snapshotVersion)>0)&&(t.vs=t.vs.insert(n.targetId,n),t.Fs.set(e,n.targetId)),n}))}async function fn(r,e,t){const n=w(r),s=n.vs.get(e),i=t?"readwrite":"readwrite-primary";try{t||await n.persistence.runTransaction("Release target",i,(o=>n.persistence.referenceDelegate.removeTarget(o,s)))}catch(o){if(!ot(o))throw o;p(Li,`Failed to update sequence numbers for target ${e}: ${o}`)}n.vs=n.vs.remove(e),n.Fs.delete(s.target)}function Jr(r,e,t){const n=w(r);let s=R.min(),i=C();return n.persistence.runTransaction("Execute query","readwrite",(o=>(function(u,c,l){const h=w(u),d=h.Fs.get(l);return d!==void 0?f.resolve(h.vs.get(d)):h.li.getTargetData(c,l)})(n,o,he(e)).next((a=>{if(a)return s=a.lastLimboFreeSnapshotVersion,n.li.getMatchingKeysForTargetId(o,a.targetId).next((u=>{i=u}))})).next((()=>n.Cs.getDocumentsMatchingQuery(o,e,t?s:R.min(),t?i:C()))).next((a=>(Lc(n,qu(e),a),{documents:a,ks:i})))))}function Mc(r,e){const t=w(r),n=w(t.li),s=t.vs.get(e);return s?Promise.resolve(s.target):t.persistence.runTransaction("Get target data","readonly",(i=>n.At(i,e).next((o=>o?o.target:null))))}function Oc(r,e){const t=w(r),n=t.Ms.get(e)||R.min();return t.persistence.runTransaction("Get new document changes","readonly",(s=>t.xs.getAllFromCollectionGroup(s,e,tu(n,Xt),Number.MAX_SAFE_INTEGER))).then((s=>(Lc(t,e,s),s)))}function Lc(r,e,t){let n=r.Ms.get(e)||R.min();t.forEach(((s,i)=>{i.readTime.compareTo(n)>0&&(n=i.readTime)})),r.Ms.set(e,n)}async function lf(r,e,t,n){const s=w(r);let i=C(),o=_e();for(const c of t){const l=e.Ks(c.metadata.name);c.document&&(i=i.add(l));const h=e.qs(c);h.setReadTime(e.Us(c.metadata.readTime)),o=o.insert(l,h)}const a=s.xs.newChangeBuffer({trackRemovals:!0}),u=await dn(s,(function(l){return he(In(x.fromString(`__bundle__/docs/${l}`)))})(n));return s.persistence.runTransaction("Apply bundle documents","readwrite",(c=>Fc(c,a,o).next((l=>(a.apply(c),l))).next((l=>s.li.removeMatchingKeysForTargetId(c,u.targetId).next((()=>s.li.addMatchingKeys(c,i,u.targetId))).next((()=>s.localDocuments.getLocalViewOfDocuments(c,l.Bs,l.Ls))).next((()=>l.Bs))))))}async function hf(r,e,t=C()){const n=await dn(r,he(fs(e.bundledQuery))),s=w(r);return s.persistence.runTransaction("Save named query","readwrite",(i=>{const o=J(e.readTime);if(n.snapshotVersion.compareTo(o)>=0)return s.Pi.saveNamedQuery(i,e);const a=n.withResumeToken(W.EMPTY_BYTE_STRING,o);return s.vs=s.vs.insert(a.targetId,a),s.li.updateTargetData(i,a).next((()=>s.li.removeMatchingKeysForTargetId(i,n.targetId))).next((()=>s.li.addMatchingKeys(i,t,n.targetId))).next((()=>s.Pi.saveNamedQuery(i,e)))}))}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const qc="firestore_clients";function ya(r,e){return`${qc}_${r}_${e}`}const Uc="firestore_mutations";function Ia(r,e,t){let n=`${Uc}_${r}_${t}`;return e.isAuthenticated()&&(n+=`_${e.uid}`),n}const Bc="firestore_targets";function Ns(r,e){return`${Bc}_${r}_${e}`}/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Re="SharedClientState";class Yr{constructor(e,t,n,s){this.user=e,this.batchId=t,this.state=n,this.error=s}static $s(e,t,n){const s=JSON.parse(n);let i,o=typeof s=="object"&&["pending","acknowledged","rejected"].indexOf(s.state)!==-1&&(s.error===void 0||typeof s.error=="object");return o&&s.error&&(o=typeof s.error.message=="string"&&typeof s.error.code=="string",o&&(i=new g(s.error.code,s.error.message))),o?new Yr(e,t,s.state,i):(H(Re,`Failed to parse mutation state for ID '${t}': ${n}`),null)}Ws(){const e={state:this.state,updateTimeMs:Date.now()};return this.error&&(e.error={code:this.error.code,message:this.error.message}),JSON.stringify(e)}}class Qn{constructor(e,t,n){this.targetId=e,this.state=t,this.error=n}static $s(e,t){const n=JSON.parse(t);let s,i=typeof n=="object"&&["not-current","current","rejected"].indexOf(n.state)!==-1&&(n.error===void 0||typeof n.error=="object");return i&&n.error&&(i=typeof n.error.message=="string"&&typeof n.error.code=="string",i&&(s=new g(n.error.code,n.error.message))),i?new Qn(e,n.state,s):(H(Re,`Failed to parse target state for ID '${e}': ${t}`),null)}Ws(){const e={state:this.state,updateTimeMs:Date.now()};return this.error&&(e.error={code:this.error.code,message:this.error.message}),JSON.stringify(e)}}class Xr{constructor(e,t){this.clientId=e,this.activeTargetIds=t}static $s(e,t){const n=JSON.parse(t);let s=typeof n=="object"&&n.activeTargetIds instanceof Array,i=Ai();for(let o=0;s&&o<n.activeTargetIds.length;++o)s=ou(n.activeTargetIds[o]),i=i.add(n.activeTargetIds[o]);return s?new Xr(e,i):(H(Re,`Failed to parse client data for instance '${e}': ${t}`),null)}}class qi{constructor(e,t){this.clientId=e,this.onlineState=t}static $s(e){const t=JSON.parse(e);return typeof t=="object"&&["Unknown","Online","Offline"].indexOf(t.onlineState)!==-1&&typeof t.clientId=="string"?new qi(t.clientId,t.onlineState):(H(Re,`Failed to parse online state: ${e}`),null)}}class si{constructor(){this.activeTargetIds=Ai()}Qs(e){this.activeTargetIds=this.activeTargetIds.add(e)}Gs(e){this.activeTargetIds=this.activeTargetIds.delete(e)}Ws(){const e={activeTargetIds:this.activeTargetIds.toArray(),updateTimeMs:Date.now()};return JSON.stringify(e)}}class ks{constructor(e,t,n,s,i){this.window=e,this.Ci=t,this.persistenceKey=n,this.zs=s,this.syncEngine=null,this.onlineStateHandler=null,this.sequenceNumberHandler=null,this.js=this.Hs.bind(this),this.Js=new U(P),this.started=!1,this.Zs=[];const o=n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");this.storage=this.window.localStorage,this.currentUser=i,this.Xs=ya(this.persistenceKey,this.zs),this.Ys=(function(u){return`firestore_sequence_number_${u}`})(this.persistenceKey),this.Js=this.Js.insert(this.zs,new si),this.eo=new RegExp(`^${qc}_${o}_([^_]*)$`),this.no=new RegExp(`^${Uc}_${o}_(\\d+)(?:_(.*))?$`),this.ro=new RegExp(`^${Bc}_${o}_(\\d+)$`),this.io=(function(u){return`firestore_online_state_${u}`})(this.persistenceKey),this.so=(function(u){return`firestore_bundle_loaded_v2_${u}`})(this.persistenceKey),this.window.addEventListener("storage",this.js)}static v(e){return!(!e||!e.localStorage)}async start(){const e=await this.syncEngine.hs();for(const n of e){if(n===this.zs)continue;const s=this.getItem(ya(this.persistenceKey,n));if(s){const i=Xr.$s(n,s);i&&(this.Js=this.Js.insert(i.clientId,i))}}this.oo();const t=this.storage.getItem(this.io);if(t){const n=this._o(t);n&&this.ao(n)}for(const n of this.Zs)this.Hs(n);this.Zs=[],this.window.addEventListener("pagehide",(()=>this.shutdown())),this.started=!0}writeSequenceNumber(e){this.setItem(this.Ys,JSON.stringify(e))}getAllActiveQueryTargets(){return this.uo(this.Js)}isActiveQueryTarget(e){let t=!1;return this.Js.forEach(((n,s)=>{s.activeTargetIds.has(e)&&(t=!0)})),t}addPendingMutation(e){this.co(e,"pending")}updateMutationState(e,t,n){this.co(e,t,n),this.lo(e)}addLocalQueryTarget(e,t=!0){let n="not-current";if(this.isActiveQueryTarget(e)){const s=this.storage.getItem(Ns(this.persistenceKey,e));if(s){const i=Qn.$s(e,s);i&&(n=i.state)}}return t&&this.ho.Qs(e),this.oo(),n}removeLocalQueryTarget(e){this.ho.Gs(e),this.oo()}isLocalQueryTarget(e){return this.ho.activeTargetIds.has(e)}clearQueryState(e){this.removeItem(Ns(this.persistenceKey,e))}updateQueryState(e,t,n){this.Po(e,t,n)}handleUserChange(e,t,n){t.forEach((s=>{this.lo(s)})),this.currentUser=e,n.forEach((s=>{this.addPendingMutation(s)}))}setOnlineState(e){this.To(e)}notifyBundleLoaded(e){this.Io(e)}shutdown(){this.started&&(this.window.removeEventListener("storage",this.js),this.removeItem(this.Xs),this.started=!1)}getItem(e){const t=this.storage.getItem(e);return p(Re,"READ",e,t),t}setItem(e,t){p(Re,"SET",e,t),this.storage.setItem(e,t)}removeItem(e){p(Re,"REMOVE",e),this.storage.removeItem(e)}Hs(e){const t=e;if(t.storageArea===this.storage){if(p(Re,"EVENT",t.key,t.newValue),t.key===this.Xs)return void H("Received WebStorage notification for local change. Another client might have garbage-collected our state");this.Ci.enqueueRetryable((async()=>{if(this.started){if(t.key!==null){if(this.eo.test(t.key)){if(t.newValue==null){const n=this.Eo(t.key);return this.Ro(n,null)}{const n=this.Ao(t.key,t.newValue);if(n)return this.Ro(n.clientId,n)}}else if(this.no.test(t.key)){if(t.newValue!==null){const n=this.Vo(t.key,t.newValue);if(n)return this.mo(n)}}else if(this.ro.test(t.key)){if(t.newValue!==null){const n=this.fo(t.key,t.newValue);if(n)return this.po(n)}}else if(t.key===this.io){if(t.newValue!==null){const n=this._o(t.newValue);if(n)return this.ao(n)}}else if(t.key===this.Ys){const n=(function(i){let o=fe.ce;if(i!=null)try{const a=JSON.parse(i);v(typeof a=="number",30636,{yo:i}),o=a}catch(a){H(Re,"Failed to read sequence number from WebStorage",a)}return o})(t.newValue);n!==fe.ce&&this.sequenceNumberHandler(n)}else if(t.key===this.so){const n=this.wo(t.newValue);await Promise.all(n.map((s=>this.syncEngine.bo(s))))}}}else this.Zs.push(t)}))}}get ho(){return this.Js.get(this.zs)}oo(){this.setItem(this.Xs,this.ho.Ws())}co(e,t,n){const s=new Yr(this.currentUser,e,t,n),i=Ia(this.persistenceKey,this.currentUser,e);this.setItem(i,s.Ws())}lo(e){const t=Ia(this.persistenceKey,this.currentUser,e);this.removeItem(t)}To(e){const t={clientId:this.zs,onlineState:e};this.storage.setItem(this.io,JSON.stringify(t))}Po(e,t,n){const s=Ns(this.persistenceKey,e),i=new Qn(e,t,n);this.setItem(s,i.Ws())}Io(e){const t=JSON.stringify(Array.from(e));this.setItem(this.so,t)}Eo(e){const t=this.eo.exec(e);return t?t[1]:null}Ao(e,t){const n=this.Eo(e);return Xr.$s(n,t)}Vo(e,t){const n=this.no.exec(e),s=Number(n[1]),i=n[2]!==void 0?n[2]:null;return Yr.$s(new re(i),s,t)}fo(e,t){const n=this.ro.exec(e),s=Number(n[1]);return Qn.$s(s,t)}_o(e){return qi.$s(e)}wo(e){return JSON.parse(e)}async mo(e){if(e.user.uid===this.currentUser.uid)return this.syncEngine.So(e.batchId,e.state,e.error);p(Re,`Ignoring mutation for non-active user ${e.user.uid}`)}po(e){return this.syncEngine.Do(e.targetId,e.state,e.error)}Ro(e,t){const n=t?this.Js.insert(e,t):this.Js.remove(e),s=this.uo(this.Js),i=this.uo(n),o=[],a=[];return i.forEach((u=>{s.has(u)||o.push(u)})),s.forEach((u=>{i.has(u)||a.push(u)})),this.syncEngine.Co(o,a).then((()=>{this.Js=n}))}ao(e){this.Js.get(e.clientId)&&this.onlineStateHandler(e.onlineState)}uo(e){let t=Ai();return e.forEach(((n,s)=>{t=t.unionWith(s.activeTargetIds)})),t}}class zc{constructor(){this.vo=new si,this.Fo={},this.onlineStateHandler=null,this.sequenceNumberHandler=null}addPendingMutation(e){}updateMutationState(e,t,n){}addLocalQueryTarget(e,t=!0){return t&&this.vo.Qs(e),this.Fo[e]||"not-current"}updateQueryState(e,t,n){this.Fo[e]=t}removeLocalQueryTarget(e){this.vo.Gs(e)}isLocalQueryTarget(e){return this.vo.activeTargetIds.has(e)}clearQueryState(e){delete this.Fo[e]}getAllActiveQueryTargets(){return this.vo.activeTargetIds}isActiveQueryTarget(e){return this.vo.activeTargetIds.has(e)}start(){return this.vo=new si,Promise.resolve()}handleUserChange(e,t,n){}setOnlineState(e){}shutdown(){}writeSequenceNumber(e){}notifyBundleLoaded(e){}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class df{Mo(e){}shutdown(){}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ta="ConnectivityMonitor";class Ea{constructor(){this.xo=()=>this.Oo(),this.No=()=>this.Bo(),this.Lo=[],this.ko()}Mo(e){this.Lo.push(e)}shutdown(){window.removeEventListener("online",this.xo),window.removeEventListener("offline",this.No)}ko(){window.addEventListener("online",this.xo),window.addEventListener("offline",this.No)}Oo(){p(Ta,"Network connectivity changed: AVAILABLE");for(const e of this.Lo)e(0)}Bo(){p(Ta,"Network connectivity changed: UNAVAILABLE");for(const e of this.Lo)e(1)}static v(){return typeof window<"u"&&window.addEventListener!==void 0&&window.removeEventListener!==void 0}}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */let Pr=null;function ii(){return Pr===null?Pr=(function(){return 268435456+Math.round(2147483648*Math.random())})():Pr++,"0x"+Pr.toString(16)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Fs="RestConnection",ff={BatchGetDocuments:"batchGet",Commit:"commit",RunQuery:"runQuery",RunAggregationQuery:"runAggregationQuery",ExecutePipeline:"executePipeline"};class mf{get Ko(){return!1}constructor(e){this.databaseInfo=e,this.databaseId=e.databaseId;const t=e.ssl?"https":"http",n=encodeURIComponent(this.databaseId.projectId),s=encodeURIComponent(this.databaseId.database);this.qo=t+"://"+e.host,this.Uo=`projects/${n}/databases/${s}`,this.$o=this.databaseId.database===Xn?`project_id=${n}`:`project_id=${n}&database_id=${s}`}Wo(e,t,n,s,i){const o=ii(),a=this.Qo(e,t.toUriEncodedString());p(Fs,`Sending RPC '${e}' ${o}:`,a,n);const u={"google-cloud-resource-prefix":this.Uo,"x-goog-request-params":this.$o};this.Go(u,s,i);const{host:c}=new URL(a),l=ci(c);return this.zo(e,a,u,n,l).then((h=>(p(Fs,`Received RPC '${e}' ${o}: `,h),h)),(h=>{throw Te(Fs,`RPC '${e}' ${o} failed with error: `,h,"url: ",a,"request:",n),h}))}jo(e,t,n,s,i,o){return this.Wo(e,t,n,s,i)}Go(e,t,n){e["X-Goog-Api-Client"]=(function(){return"gl-js/ fire/"+yn})(),e["Content-Type"]="text/plain",this.databaseInfo.appId&&(e["X-Firebase-GMPID"]=this.databaseInfo.appId),t&&t.headers.forEach(((s,i)=>e[i]=s)),n&&n.headers.forEach(((s,i)=>e[i]=s))}Qo(e,t){const n=ff[e];let s=`${this.qo}/v1/${t}:${n}`;return this.databaseInfo.apiKey&&(s=`${s}?key=${encodeURIComponent(this.databaseInfo.apiKey)}`),s}terminate(){}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class _f{constructor(e){this.Ho=e.Ho,this.Jo=e.Jo}Zo(e){this.Xo=e}Yo(e){this.e_=e}t_(e){this.n_=e}onMessage(e){this.r_=e}close(){this.Jo()}send(e){this.Ho(e)}i_(){this.Xo()}s_(){this.e_()}o_(e){this.n_(e)}__(e){this.r_(e)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ue="WebChannelConnection",kn=(r,e,t)=>{r.listen(e,(n=>{try{t(n)}catch(s){setTimeout((()=>{throw s}),0)}}))};class Ht extends mf{constructor(e){super(e),this.a_=[],this.forceLongPolling=e.forceLongPolling,this.autoDetectLongPolling=e.autoDetectLongPolling,this.useFetchStreams=e.useFetchStreams,this.longPollingOptions=e.longPollingOptions}static u_(){if(!Ht.c_){const e=Ul();kn(e,Bl.STAT_EVENT,(t=>{t.stat===Io.PROXY?p(ue,"STAT_EVENT: detected buffering proxy"):t.stat===Io.NOPROXY&&p(ue,"STAT_EVENT: detected no buffering proxy")})),Ht.c_=!0}}zo(e,t,n,s,i){const o=ii();return new Promise(((a,u)=>{const c=new zl;c.setWithCredentials(!0),c.listenOnce(Gl.COMPLETE,(()=>{try{switch(c.getLastErrorCode()){case Ps.NO_ERROR:const h=c.getResponseJson();p(ue,`XHR for RPC '${e}' ${o} received:`,JSON.stringify(h)),a(h);break;case Ps.TIMEOUT:p(ue,`RPC '${e}' ${o} timed out`),u(new g(m.DEADLINE_EXCEEDED,"Request time out"));break;case Ps.HTTP_ERROR:const d=c.getStatus();if(p(ue,`RPC '${e}' ${o} failed with status:`,d,"response text:",c.getResponseText()),d>0){let _=c.getResponseJson();Array.isArray(_)&&(_=_[0]);const y=_==null?void 0:_.error;if(y&&y.status&&y.message){const I=(function(V){const S=V.toLowerCase().replace(/_/g,"-");return Object.values(m).indexOf(S)>=0?S:m.UNKNOWN})(y.status);u(new g(I,y.message))}else u(new g(m.UNKNOWN,"Server responded with status "+c.getStatus()))}else u(new g(m.UNAVAILABLE,"Connection failed."));break;default:A(9055,{l_:e,streamId:o,h_:c.getLastErrorCode(),P_:c.getLastError()})}}finally{p(ue,`RPC '${e}' ${o} completed.`)}}));const l=JSON.stringify(s);p(ue,`RPC '${e}' ${o} sending request:`,s),c.send(t,"POST",l,n,15)}))}T_(e,t,n){const s=ii(),i=[this.qo,"/","google.firestore.v1.Firestore","/",e,"/channel"],o=this.createWebChannelTransport(),a={httpSessionIdParam:"gsessionid",initMessageHeaders:{},messageUrlParams:{database:`projects/${this.databaseId.projectId}/databases/${this.databaseId.database}`},sendRawJson:!0,supportsCrossDomainXhr:!0,internalChannelParams:{forwardChannelRequestTimeoutMs:6e5},forceLongPolling:this.forceLongPolling,detectBufferingProxy:this.autoDetectLongPolling},u=this.longPollingOptions.timeoutSeconds;u!==void 0&&(a.longPollingTimeout=Math.round(1e3*u)),this.useFetchStreams&&(a.useFetchStreams=!0),this.Go(a.initMessageHeaders,t,n),a.encodeInitMessageHeaders=!0;const c=i.join("");p(ue,`Creating RPC '${e}' stream ${s}: ${c}`,a);const l=o.createWebChannel(c,a);this.I_(l);let h=!1,d=!1;const _=new _f({Ho:y=>{d?p(ue,`Not sending because RPC '${e}' stream ${s} is closed:`,y):(h||(p(ue,`Opening RPC '${e}' stream ${s} transport.`),l.open(),h=!0),p(ue,`RPC '${e}' stream ${s} sending:`,y),l.send(y))},Jo:()=>l.close()});return kn(l,Er.EventType.OPEN,(()=>{d||(p(ue,`RPC '${e}' stream ${s} transport opened.`),_.i_())})),kn(l,Er.EventType.CLOSE,(()=>{d||(d=!0,p(ue,`RPC '${e}' stream ${s} transport closed`),_.o_(),this.E_(l))})),kn(l,Er.EventType.ERROR,(y=>{d||(d=!0,Te(ue,`RPC '${e}' stream ${s} transport errored. Name:`,y.name,"Message:",y.message),_.o_(new g(m.UNAVAILABLE,"The operation could not be completed")))})),kn(l,Er.EventType.MESSAGE,(y=>{var I;if(!d){const T=y.data[0];v(!!T,16349);const V=T,S=(V==null?void 0:V.error)||((I=V[0])==null?void 0:I.error);if(S){p(ue,`RPC '${e}' stream ${s} received error:`,S);const b=S.status;let Q=(function(de){const ze=Y[de];if(ze!==void 0)return ec(ze)})(b),z=S.message;b==="NOT_FOUND"&&z.includes("database")&&z.includes("does not exist")&&z.includes(this.databaseId.database)&&Te(`Database '${this.databaseId.database}' not found. Please check your project configuration.`),Q===void 0&&(Q=m.INTERNAL,z="Unknown error status: "+b+" with message "+S.message),d=!0,_.o_(new g(Q,z)),l.close()}else p(ue,`RPC '${e}' stream ${s} received:`,T),_.__(T)}})),Ht.u_(),setTimeout((()=>{_.s_()}),0),_}terminate(){this.a_.forEach((e=>e.close())),this.a_=[]}I_(e){this.a_.push(e)}E_(e){this.a_=this.a_.filter((t=>t===e))}Go(e,t,n){super.Go(e,t,n),this.databaseInfo.apiKey&&(e["x-goog-api-key"]=this.databaseInfo.apiKey)}createWebChannelTransport(){return $l()}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function gf(r){return new Ht(r)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Gc(){return typeof window<"u"?window:null}function Or(){return typeof document<"u"?document:null}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function kt(r){return new Ed(r,!0)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */Ht.c_=!1;class Ui{constructor(e,t,n=1e3,s=1.5,i=6e4){this.Ci=e,this.timerId=t,this.R_=n,this.A_=s,this.V_=i,this.d_=0,this.m_=null,this.f_=Date.now(),this.reset()}reset(){this.d_=0}g_(){this.d_=this.V_}p_(e){this.cancel();const t=Math.floor(this.d_+this.y_()),n=Math.max(0,Date.now()-this.f_),s=Math.max(0,t-n);s>0&&p("ExponentialBackoff",`Backing off for ${s} ms (base delay: ${this.d_} ms, delay with jitter: ${t} ms, last attempt: ${n} ms ago)`),this.m_=this.Ci.enqueueAfterDelay(this.timerId,s,(()=>(this.f_=Date.now(),e()))),this.d_*=this.A_,this.d_<this.R_&&(this.d_=this.R_),this.d_>this.V_&&(this.d_=this.V_)}w_(){this.m_!==null&&(this.m_.skipDelay(),this.m_=null)}cancel(){this.m_!==null&&(this.m_.cancel(),this.m_=null)}y_(){return(Math.random()-.5)*this.d_}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const wa="PersistentStream";class $c{constructor(e,t,n,s,i,o,a,u){this.Ci=e,this.b_=n,this.S_=s,this.connection=i,this.authCredentialsProvider=o,this.appCheckCredentialsProvider=a,this.listener=u,this.state=0,this.D_=0,this.C_=null,this.v_=null,this.stream=null,this.F_=0,this.M_=new Ui(e,t)}x_(){return this.state===1||this.state===5||this.O_()}O_(){return this.state===2||this.state===3}start(){this.F_=0,this.state!==4?this.auth():this.N_()}async stop(){this.x_()&&await this.close(0)}B_(){this.state=0,this.M_.reset()}L_(){this.O_()&&this.C_===null&&(this.C_=this.Ci.enqueueAfterDelay(this.b_,6e4,(()=>this.k_())))}K_(e){this.q_(),this.stream.send(e)}async k_(){if(this.O_())return this.close(0)}q_(){this.C_&&(this.C_.cancel(),this.C_=null)}U_(){this.v_&&(this.v_.cancel(),this.v_=null)}async close(e,t){this.q_(),this.U_(),this.M_.cancel(),this.D_++,e!==4?this.M_.reset():t&&t.code===m.RESOURCE_EXHAUSTED?(H(t.toString()),H("Using maximum backoff delay to prevent overloading the backend."),this.M_.g_()):t&&t.code===m.UNAUTHENTICATED&&this.state!==3&&(this.authCredentialsProvider.invalidateToken(),this.appCheckCredentialsProvider.invalidateToken()),this.stream!==null&&(this.W_(),this.stream.close(),this.stream=null),this.state=e,await this.listener.t_(t)}W_(){}auth(){this.state=1;const e=this.Q_(this.D_),t=this.D_;Promise.all([this.authCredentialsProvider.getToken(),this.appCheckCredentialsProvider.getToken()]).then((([n,s])=>{this.D_===t&&this.G_(n,s)}),(n=>{e((()=>{const s=new g(m.UNKNOWN,"Fetching auth token failed: "+n.message);return this.z_(s)}))}))}G_(e,t){const n=this.Q_(this.D_);this.stream=this.j_(e,t),this.stream.Zo((()=>{n((()=>this.listener.Zo()))})),this.stream.Yo((()=>{n((()=>(this.state=2,this.v_=this.Ci.enqueueAfterDelay(this.S_,1e4,(()=>(this.O_()&&(this.state=3),Promise.resolve()))),this.listener.Yo())))})),this.stream.t_((s=>{n((()=>this.z_(s)))})),this.stream.onMessage((s=>{n((()=>++this.F_==1?this.H_(s):this.onNext(s)))}))}N_(){this.state=5,this.M_.p_((async()=>{this.state=0,this.start()}))}z_(e){return p(wa,`close with error: ${e}`),this.stream=null,this.close(4,e)}Q_(e){return t=>{this.Ci.enqueueAndForget((()=>this.D_===e?t():(p(wa,"stream callback skipped by getCloseGuardedDispatcher."),Promise.resolve())))}}}class pf extends $c{constructor(e,t,n,s,i,o){super(e,"listen_stream_connection_backoff","listen_stream_idle","health_check_timeout",t,n,s,o),this.serializer=i}j_(e,t){return this.connection.T_("Listen",e,t)}H_(e){return this.onNext(e)}onNext(e){this.M_.reset();const t=vd(this.serializer,e),n=(function(i){if(!("targetChange"in i))return R.min();const o=i.targetChange;return o.targetIds&&o.targetIds.length?R.min():o.readTime?J(o.readTime):R.min()})(e);return this.listener.J_(t,n)}Z_(e){const t={};t.database=Zs(this.serializer),t.addTarget=(function(i,o){let a;const u=o.target;if(a=Gr(u)?{documents:cc(i,u)}:{query:ds(i,u).ft},a.targetId=o.targetId,o.resumeToken.approximateByteSize()>0){a.resumeToken=sc(i,o.resumeToken);const c=Ys(i,o.expectedCount);c!==null&&(a.expectedCount=c)}else if(o.snapshotVersion.compareTo(R.min())>0){a.readTime=hn(i,o.snapshotVersion.toTimestamp());const c=Ys(i,o.expectedCount);c!==null&&(a.expectedCount=c)}return a})(this.serializer,e);const n=Vd(this.serializer,e);n&&(t.labels=n),this.K_(t)}X_(e){const t={};t.database=Zs(this.serializer),t.removeTarget=e,this.K_(t)}}class yf extends $c{constructor(e,t,n,s,i,o){super(e,"write_stream_connection_backoff","write_stream_idle","health_check_timeout",t,n,s,o),this.serializer=i}get Y_(){return this.F_>0}start(){this.lastStreamToken=void 0,super.start()}W_(){this.Y_&&this.ea([])}j_(e,t){return this.connection.T_("Write",e,t)}H_(e){return v(!!e.streamToken,31322),this.lastStreamToken=e.streamToken,v(!e.writeResults||e.writeResults.length===0,55816),this.listener.ta()}onNext(e){v(!!e.streamToken,12678),this.lastStreamToken=e.streamToken,this.M_.reset();const t=Rd(e.writeResults,e.commitTime),n=J(e.commitTime);return this.listener.na(n,t)}ra(){const e={};e.database=Zs(this.serializer),this.K_(e)}ea(e){const t={streamToken:this.lastStreamToken,writes:e.map((n=>rr(this.serializer,n)))};this.K_(t)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class If{}class Tf extends If{constructor(e,t,n,s){super(),this.authCredentials=e,this.appCheckCredentials=t,this.connection=n,this.serializer=s,this.ia=!1}sa(){if(this.ia)throw new g(m.FAILED_PRECONDITION,"The client has already been terminated.")}Wo(e,t,n,s){return this.sa(),Promise.all([this.authCredentials.getToken(),this.appCheckCredentials.getToken()]).then((([i,o])=>this.connection.Wo(e,Xs(t,n),s,i,o))).catch((i=>{throw i.name==="FirebaseError"?(i.code===m.UNAUTHENTICATED&&(this.authCredentials.invalidateToken(),this.appCheckCredentials.invalidateToken()),i):new g(m.UNKNOWN,i.toString())}))}jo(e,t,n,s,i){return this.sa(),Promise.all([this.authCredentials.getToken(),this.appCheckCredentials.getToken()]).then((([o,a])=>this.connection.jo(e,Xs(t,n),s,o,a,i))).catch((o=>{throw o.name==="FirebaseError"?(o.code===m.UNAUTHENTICATED&&(this.authCredentials.invalidateToken(),this.appCheckCredentials.invalidateToken()),o):new g(m.UNKNOWN,o.toString())}))}terminate(){this.ia=!0,this.connection.terminate()}}function Ef(r,e,t,n){return new Tf(r,e,t,n)}class wf{constructor(e,t){this.asyncQueue=e,this.onlineStateHandler=t,this.state="Unknown",this.oa=0,this._a=null,this.aa=!0}ua(){this.oa===0&&(this.ca("Unknown"),this._a=this.asyncQueue.enqueueAfterDelay("online_state_timeout",1e4,(()=>(this._a=null,this.la("Backend didn't respond within 10 seconds."),this.ca("Offline"),Promise.resolve()))))}ha(e){this.state==="Online"?this.ca("Unknown"):(this.oa++,this.oa>=1&&(this.Pa(),this.la(`Connection failed 1 times. Most recent error: ${e.toString()}`),this.ca("Offline")))}set(e){this.Pa(),this.oa=0,e==="Online"&&(this.aa=!1),this.ca(e)}ca(e){e!==this.state&&(this.state=e,this.onlineStateHandler(e))}la(e){const t=`Could not reach Cloud Firestore backend. ${e}
This typically indicates that your device does not have a healthy Internet connection at the moment. The client will operate in offline mode until it is able to successfully connect to the backend.`;this.aa?(H(t),this.aa=!1):p("OnlineStateTracker",t)}Pa(){this._a!==null&&(this._a.cancel(),this._a=null)}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const xt="RemoteStore";class Af{constructor(e,t,n,s,i){this.localStore=e,this.datastore=t,this.asyncQueue=n,this.remoteSyncer={},this.Ta=[],this.Ia=new Map,this.Ea=new Set,this.Ra=[],this.Aa=i,this.Aa.Mo((o=>{n.enqueueAndForget((async()=>{ut(this)&&(p(xt,"Restarting streams for network reachability change."),await(async function(u){const c=w(u);c.Ea.add(4),await wn(c),c.Va.set("Unknown"),c.Ea.delete(4),await _r(c)})(this))}))})),this.Va=new wf(n,s)}}async function _r(r){if(ut(r))for(const e of r.Ra)await e(!0)}async function wn(r){for(const e of r.Ra)await e(!1)}function ps(r,e){const t=w(r);t.Ia.has(e.targetId)||(t.Ia.set(e.targetId,e),Gi(t)?zi(t):vn(t).O_()&&Bi(t,e))}function mn(r,e){const t=w(r),n=vn(t);t.Ia.delete(e),n.O_()&&Kc(t,e),t.Ia.size===0&&(n.O_()?n.L_():ut(t)&&t.Va.set("Unknown"))}function Bi(r,e){if(r.da.$e(e.targetId),e.resumeToken.approximateByteSize()>0||e.snapshotVersion.compareTo(R.min())>0){const t=r.remoteSyncer.getRemoteKeysForTarget(e.targetId).size;e=e.withExpectedCount(t)}vn(r).Z_(e)}function Kc(r,e){r.da.$e(e),vn(r).X_(e)}function zi(r){r.da=new pd({getRemoteKeysForTarget:e=>r.remoteSyncer.getRemoteKeysForTarget(e),At:e=>r.Ia.get(e)||null,ht:()=>r.datastore.serializer.databaseId}),vn(r).start(),r.Va.ua()}function Gi(r){return ut(r)&&!vn(r).x_()&&r.Ia.size>0}function ut(r){return w(r).Ea.size===0}function Qc(r){r.da=void 0}async function vf(r){r.Va.set("Online")}async function Rf(r){r.Ia.forEach(((e,t)=>{Bi(r,e)}))}async function Vf(r,e){Qc(r),Gi(r)?(r.Va.ha(e),zi(r)):r.Va.set("Unknown")}async function Pf(r,e,t){if(r.Va.set("Online"),e instanceof rc&&e.state===2&&e.cause)try{await(async function(s,i){const o=i.cause;for(const a of i.targetIds)s.Ia.has(a)&&(await s.remoteSyncer.rejectListen(a,o),s.Ia.delete(a),s.da.removeTarget(a))})(r,e)}catch(n){p(xt,"Failed to remove targets %s: %s ",e.targetIds.join(","),n),await Zr(r,n)}else if(e instanceof Fr?r.da.Xe(e):e instanceof nc?r.da.st(e):r.da.tt(e),!t.isEqual(R.min()))try{const n=await kc(r.localStore);t.compareTo(n)>=0&&await(function(i,o){const a=i.da.Tt(o);return a.targetChanges.forEach(((u,c)=>{if(u.resumeToken.approximateByteSize()>0){const l=i.Ia.get(c);l&&i.Ia.set(c,l.withResumeToken(u.resumeToken,o))}})),a.targetMismatches.forEach(((u,c)=>{const l=i.Ia.get(u);if(!l)return;i.Ia.set(u,l.withResumeToken(W.EMPTY_BYTE_STRING,l.snapshotVersion)),Kc(i,u);const h=new ke(l.target,u,c,l.sequenceNumber);Bi(i,h)})),i.remoteSyncer.applyRemoteEvent(a)})(r,t)}catch(n){p(xt,"Failed to raise snapshot:",n),await Zr(r,n)}}async function Zr(r,e,t){if(!ot(e))throw e;r.Ea.add(1),await wn(r),r.Va.set("Offline"),t||(t=()=>kc(r.localStore)),r.asyncQueue.enqueueRetryable((async()=>{p(xt,"Retrying IndexedDB access"),await t(),r.Ea.delete(1),await _r(r)}))}function jc(r,e){return e().catch((t=>Zr(r,t,e)))}async function An(r){const e=w(r),t=nt(e);let n=e.Ta.length>0?e.Ta[e.Ta.length-1].batchId:Ye;for(;bf(e);)try{const s=await cf(e.localStore,n);if(s===null){e.Ta.length===0&&t.L_();break}n=s.batchId,Sf(e,s)}catch(s){await Zr(e,s)}Wc(e)&&Hc(e)}function bf(r){return ut(r)&&r.Ta.length<10}function Sf(r,e){r.Ta.push(e);const t=nt(r);t.O_()&&t.Y_&&t.ea(e.mutations)}function Wc(r){return ut(r)&&!nt(r).x_()&&r.Ta.length>0}function Hc(r){nt(r).start()}async function Cf(r){nt(r).ra()}async function xf(r){const e=nt(r);for(const t of r.Ta)e.ea(t.mutations)}async function Df(r,e,t){const n=r.Ta.shift(),s=Pi.from(n,e,t);await jc(r,(()=>r.remoteSyncer.applySuccessfulWrite(s))),await An(r)}async function Nf(r,e){e&&nt(r).Y_&&await(async function(n,s){if((function(o){return Zu(o)&&o!==m.ABORTED})(s.code)){const i=n.Ta.shift();nt(n).B_(),await jc(n,(()=>n.remoteSyncer.rejectFailedWrite(i.batchId,s))),await An(n)}})(r,e),Wc(r)&&Hc(r)}async function Aa(r,e){const t=w(r);t.asyncQueue.verifyOperationInProgress(),p(xt,"RemoteStore received new credentials");const n=ut(t);t.Ea.add(3),await wn(t),n&&t.Va.set("Unknown"),await t.remoteSyncer.handleCredentialChange(e),t.Ea.delete(3),await _r(t)}async function oi(r,e){const t=w(r);e?(t.Ea.delete(2),await _r(t)):e||(t.Ea.add(2),await wn(t),t.Va.set("Unknown"))}function vn(r){return r.ma||(r.ma=(function(t,n,s){const i=w(t);return i.sa(),new pf(n,i.connection,i.authCredentials,i.appCheckCredentials,i.serializer,s)})(r.datastore,r.asyncQueue,{Zo:vf.bind(null,r),Yo:Rf.bind(null,r),t_:Vf.bind(null,r),J_:Pf.bind(null,r)}),r.Ra.push((async e=>{e?(r.ma.B_(),Gi(r)?zi(r):r.Va.set("Unknown")):(await r.ma.stop(),Qc(r))}))),r.ma}function nt(r){return r.fa||(r.fa=(function(t,n,s){const i=w(t);return i.sa(),new yf(n,i.connection,i.authCredentials,i.appCheckCredentials,i.serializer,s)})(r.datastore,r.asyncQueue,{Zo:()=>Promise.resolve(),Yo:Cf.bind(null,r),t_:Nf.bind(null,r),ta:xf.bind(null,r),na:Df.bind(null,r)}),r.Ra.push((async e=>{e?(r.fa.B_(),await An(r)):(await r.fa.stop(),r.Ta.length>0&&(p(xt,`Stopping write stream with ${r.Ta.length} pending writes`),r.Ta=[]))}))),r.fa}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class $i{constructor(e,t,n,s,i){this.asyncQueue=e,this.timerId=t,this.targetTimeMs=n,this.op=s,this.removalCallback=i,this.deferred=new ie,this.then=this.deferred.promise.then.bind(this.deferred.promise),this.deferred.promise.catch((o=>{}))}get promise(){return this.deferred.promise}static createAndSchedule(e,t,n,s,i){const o=Date.now()+n,a=new $i(e,t,o,s,i);return a.start(n),a}start(e){this.timerHandle=setTimeout((()=>this.handleDelayElapsed()),e)}skipDelay(){return this.handleDelayElapsed()}cancel(e){this.timerHandle!==null&&(this.clearTimeout(),this.deferred.reject(new g(m.CANCELLED,"Operation cancelled"+(e?": "+e:""))))}handleDelayElapsed(){this.asyncQueue.enqueueAndForget((()=>this.timerHandle!==null?(this.clearTimeout(),this.op().then((e=>this.deferred.resolve(e)))):Promise.resolve()))}clearTimeout(){this.timerHandle!==null&&(this.removalCallback(this),clearTimeout(this.timerHandle),this.timerHandle=null)}}function Rn(r,e){if(H("AsyncQueue",`${e}: ${r}`),ot(r))return new g(m.UNAVAILABLE,`${e}: ${r}`);throw r}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class wt{static emptySet(e){return new wt(e.comparator)}constructor(e){this.comparator=e?(t,n)=>e(t,n)||E.comparator(t.key,n.key):(t,n)=>E.comparator(t.key,n.key),this.keyedMap=Fn(),this.sortedSet=new U(this.comparator)}has(e){return this.keyedMap.get(e)!=null}get(e){return this.keyedMap.get(e)}first(){return this.sortedSet.minKey()}last(){return this.sortedSet.maxKey()}isEmpty(){return this.sortedSet.isEmpty()}indexOf(e){const t=this.keyedMap.get(e);return t?this.sortedSet.indexOf(t):-1}get size(){return this.sortedSet.size}forEach(e){this.sortedSet.inorderTraversal(((t,n)=>(e(t),!1)))}add(e){const t=this.delete(e.key);return t.copy(t.keyedMap.insert(e.key,e),t.sortedSet.insert(e,null))}delete(e){const t=this.get(e);return t?this.copy(this.keyedMap.remove(e),this.sortedSet.remove(t)):this}isEqual(e){if(!(e instanceof wt)||this.size!==e.size)return!1;const t=this.sortedSet.getIterator(),n=e.sortedSet.getIterator();for(;t.hasNext();){const s=t.getNext().key,i=n.getNext().key;if(!s.isEqual(i))return!1}return!0}toString(){const e=[];return this.forEach((t=>{e.push(t.toString())})),e.length===0?"DocumentSet ()":`DocumentSet (
  `+e.join(`  
`)+`
)`}copy(e,t){const n=new wt;return n.comparator=this.comparator,n.keyedMap=e,n.sortedSet=t,n}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class va{constructor(){this.ga=new U(E.comparator)}track(e){const t=e.doc.key,n=this.ga.get(t);n?e.type!==0&&n.type===3?this.ga=this.ga.insert(t,e):e.type===3&&n.type!==1?this.ga=this.ga.insert(t,{type:n.type,doc:e.doc}):e.type===2&&n.type===2?this.ga=this.ga.insert(t,{type:2,doc:e.doc}):e.type===2&&n.type===0?this.ga=this.ga.insert(t,{type:0,doc:e.doc}):e.type===1&&n.type===0?this.ga=this.ga.remove(t):e.type===1&&n.type===2?this.ga=this.ga.insert(t,{type:1,doc:n.doc}):e.type===0&&n.type===1?this.ga=this.ga.insert(t,{type:2,doc:e.doc}):A(63341,{Vt:e,pa:n}):this.ga=this.ga.insert(t,e)}ya(){const e=[];return this.ga.inorderTraversal(((t,n)=>{e.push(n)})),e}}class Dt{constructor(e,t,n,s,i,o,a,u,c){this.query=e,this.docs=t,this.oldDocs=n,this.docChanges=s,this.mutatedKeys=i,this.fromCache=o,this.syncStateChanged=a,this.excludesMetadataChanges=u,this.hasCachedResults=c}static fromInitialDocuments(e,t,n,s,i){const o=[];return t.forEach((a=>{o.push({type:0,doc:a})})),new Dt(e,t,wt.emptySet(t),o,n,s,!0,!1,i)}get hasPendingWrites(){return!this.mutatedKeys.isEmpty()}isEqual(e){if(!(this.fromCache===e.fromCache&&this.hasCachedResults===e.hasCachedResults&&this.syncStateChanged===e.syncStateChanged&&this.mutatedKeys.isEqual(e.mutatedKeys)&&lr(this.query,e.query)&&this.docs.isEqual(e.docs)&&this.oldDocs.isEqual(e.oldDocs)))return!1;const t=this.docChanges,n=e.docChanges;if(t.length!==n.length)return!1;for(let s=0;s<t.length;s++)if(t[s].type!==n[s].type||!t[s].doc.isEqual(n[s].doc))return!1;return!0}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class kf{constructor(){this.wa=void 0,this.ba=[]}Sa(){return this.ba.some((e=>e.Da()))}}class Ff{constructor(){this.queries=Ra(),this.onlineState="Unknown",this.Ca=new Set}terminate(){(function(t,n){const s=w(t),i=s.queries;s.queries=Ra(),i.forEach(((o,a)=>{for(const u of a.ba)u.onError(n)}))})(this,new g(m.ABORTED,"Firestore shutting down"))}}function Ra(){return new qe((r=>Lu(r)),lr)}async function Ki(r,e){const t=w(r);let n=3;const s=e.query;let i=t.queries.get(s);i?!i.Sa()&&e.Da()&&(n=2):(i=new kf,n=e.Da()?0:1);try{switch(n){case 0:i.wa=await t.onListen(s,!0);break;case 1:i.wa=await t.onListen(s,!1);break;case 2:await t.onFirstRemoteStoreListen(s)}}catch(o){const a=Rn(o,`Initialization of query '${Kt(e.query)}' failed`);return void e.onError(a)}t.queries.set(s,i),i.ba.push(e),e.va(t.onlineState),i.wa&&e.Fa(i.wa)&&ji(t)}async function Qi(r,e){const t=w(r),n=e.query;let s=3;const i=t.queries.get(n);if(i){const o=i.ba.indexOf(e);o>=0&&(i.ba.splice(o,1),i.ba.length===0?s=e.Da()?0:1:!i.Sa()&&e.Da()&&(s=2))}switch(s){case 0:return t.queries.delete(n),t.onUnlisten(n,!0);case 1:return t.queries.delete(n),t.onUnlisten(n,!1);case 2:return t.onLastRemoteStoreUnlisten(n);default:return}}function Mf(r,e){const t=w(r);let n=!1;for(const s of e){const i=s.query,o=t.queries.get(i);if(o){for(const a of o.ba)a.Fa(s)&&(n=!0);o.wa=s}}n&&ji(t)}function Of(r,e,t){const n=w(r),s=n.queries.get(e);if(s)for(const i of s.ba)i.onError(t);n.queries.delete(e)}function ji(r){r.Ca.forEach((e=>{e.next()}))}var ai,Va;(Va=ai||(ai={})).Ma="default",Va.Cache="cache";class Wi{constructor(e,t,n){this.query=e,this.xa=t,this.Oa=!1,this.Na=null,this.onlineState="Unknown",this.options=n||{}}Fa(e){if(!this.options.includeMetadataChanges){const n=[];for(const s of e.docChanges)s.type!==3&&n.push(s);e=new Dt(e.query,e.docs,e.oldDocs,n,e.mutatedKeys,e.fromCache,e.syncStateChanged,!0,e.hasCachedResults)}let t=!1;return this.Oa?this.Ba(e)&&(this.xa.next(e),t=!0):this.La(e,this.onlineState)&&(this.ka(e),t=!0),this.Na=e,t}onError(e){this.xa.error(e)}va(e){this.onlineState=e;let t=!1;return this.Na&&!this.Oa&&this.La(this.Na,e)&&(this.ka(this.Na),t=!0),t}La(e,t){if(!e.fromCache||!this.Da())return!0;const n=t!=="Offline";return(!this.options.Ka||!n)&&(!e.docs.isEmpty()||e.hasCachedResults||t==="Offline")}Ba(e){if(e.docChanges.length>0)return!0;const t=this.Na&&this.Na.hasPendingWrites!==e.hasPendingWrites;return!(!e.syncStateChanged&&!t)&&this.options.includeMetadataChanges===!0}ka(e){e=Dt.fromInitialDocuments(e.query,e.docs,e.mutatedKeys,e.fromCache,e.hasCachedResults),this.Oa=!0,this.xa.next(e)}Da(){return this.options.source!==ai.Cache}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Jc{constructor(e,t){this.qa=e,this.byteLength=t}Ua(){return"metadata"in this.qa}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Pa{constructor(e){this.serializer=e}Ks(e){return Se(this.serializer,e)}qs(e){return e.metadata.exists?hs(this.serializer,e.document,!1):B.newNoDocument(this.Ks(e.metadata.name),this.Us(e.metadata.readTime))}Us(e){return J(e)}}class Hi{constructor(e,t){this.$a=e,this.serializer=t,this.Wa=[],this.Qa=[],this.collectionGroups=new Set,this.progress=Yc(e)}get queries(){return this.Wa}get documents(){return this.Qa}Ga(e){this.progress.bytesLoaded+=e.byteLength;let t=this.progress.documentsLoaded;if(e.qa.namedQuery)this.Wa.push(e.qa.namedQuery);else if(e.qa.documentMetadata){this.Qa.push({metadata:e.qa.documentMetadata}),e.qa.documentMetadata.exists||++t;const n=x.fromString(e.qa.documentMetadata.name);this.collectionGroups.add(n.get(n.length-2))}else e.qa.document&&(this.Qa[this.Qa.length-1].document=e.qa.document,++t);return t!==this.progress.documentsLoaded?(this.progress.documentsLoaded=t,{...this.progress}):null}za(e){const t=new Map,n=new Pa(this.serializer);for(const s of e)if(s.metadata.queries){const i=n.Ks(s.metadata.name);for(const o of s.metadata.queries){const a=(t.get(o)||C()).add(i);t.set(o,a)}}return t}async ja(e){const t=await lf(e,new Pa(this.serializer),this.Qa,this.$a.id),n=this.za(this.documents);for(const s of this.Wa)await hf(e,s,n.get(s.name));return this.progress.taskState="Success",{progress:this.progress,Ha:this.collectionGroups,Ja:t}}}function Yc(r){return{taskState:"Running",documentsLoaded:0,bytesLoaded:0,totalDocuments:r.totalDocuments,totalBytes:r.totalBytes}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Xc{constructor(e){this.key=e}}class Zc{constructor(e){this.key=e}}class el{constructor(e,t){this.query=e,this.Za=t,this.Xa=null,this.hasCachedResults=!1,this.current=!1,this.Ya=C(),this.mutatedKeys=C(),this.eu=Uu(e),this.tu=new wt(this.eu)}get nu(){return this.Za}ru(e,t){const n=t?t.iu:new va,s=t?t.tu:this.tu;let i=t?t.mutatedKeys:this.mutatedKeys,o=s,a=!1;const u=this.query.limitType==="F"&&s.size===this.query.limit?s.last():null,c=this.query.limitType==="L"&&s.size===this.query.limit?s.first():null;if(e.inorderTraversal(((l,h)=>{const d=s.get(l),_=hr(this.query,h)?h:null,y=!!d&&this.mutatedKeys.has(d.key),I=!!_&&(_.hasLocalMutations||this.mutatedKeys.has(_.key)&&_.hasCommittedMutations);let T=!1;d&&_?d.data.isEqual(_.data)?y!==I&&(n.track({type:3,doc:_}),T=!0):this.su(d,_)||(n.track({type:2,doc:_}),T=!0,(u&&this.eu(_,u)>0||c&&this.eu(_,c)<0)&&(a=!0)):!d&&_?(n.track({type:0,doc:_}),T=!0):d&&!_&&(n.track({type:1,doc:d}),T=!0,(u||c)&&(a=!0)),T&&(_?(o=o.add(_),i=I?i.add(l):i.delete(l)):(o=o.delete(l),i=i.delete(l)))})),this.query.limit!==null)for(;o.size>this.query.limit;){const l=this.query.limitType==="F"?o.last():o.first();o=o.delete(l.key),i=i.delete(l.key),n.track({type:1,doc:l})}return{tu:o,iu:n,Ss:a,mutatedKeys:i}}su(e,t){return e.hasLocalMutations&&t.hasCommittedMutations&&!t.hasLocalMutations}applyChanges(e,t,n,s){const i=this.tu;this.tu=e.tu,this.mutatedKeys=e.mutatedKeys;const o=e.iu.ya();o.sort(((l,h)=>(function(_,y){const I=T=>{switch(T){case 0:return 1;case 2:case 3:return 2;case 1:return 0;default:return A(20277,{Vt:T})}};return I(_)-I(y)})(l.type,h.type)||this.eu(l.doc,h.doc))),this.ou(n),s=s??!1;const a=t&&!s?this._u():[],u=this.Ya.size===0&&this.current&&!s?1:0,c=u!==this.Xa;return this.Xa=u,o.length!==0||c?{snapshot:new Dt(this.query,e.tu,i,o,e.mutatedKeys,u===0,c,!1,!!n&&n.resumeToken.approximateByteSize()>0),au:a}:{au:a}}va(e){return this.current&&e==="Offline"?(this.current=!1,this.applyChanges({tu:this.tu,iu:new va,mutatedKeys:this.mutatedKeys,Ss:!1},!1)):{au:[]}}uu(e){return!this.Za.has(e)&&!!this.tu.has(e)&&!this.tu.get(e).hasLocalMutations}ou(e){e&&(e.addedDocuments.forEach((t=>this.Za=this.Za.add(t))),e.modifiedDocuments.forEach((t=>{})),e.removedDocuments.forEach((t=>this.Za=this.Za.delete(t))),this.current=e.current)}_u(){if(!this.current)return[];const e=this.Ya;this.Ya=C(),this.tu.forEach((n=>{this.uu(n.key)&&(this.Ya=this.Ya.add(n.key))}));const t=[];return e.forEach((n=>{this.Ya.has(n)||t.push(new Zc(n))})),this.Ya.forEach((n=>{e.has(n)||t.push(new Xc(n))})),t}cu(e){this.Za=e.ks,this.Ya=C();const t=this.ru(e.documents);return this.applyChanges(t,!0)}lu(){return Dt.fromInitialDocuments(this.query,this.tu,this.mutatedKeys,this.Xa===0,this.hasCachedResults)}}const ct="SyncEngine";class Lf{constructor(e,t,n){this.query=e,this.targetId=t,this.view=n}}class qf{constructor(e){this.key=e,this.hu=!1}}class Uf{constructor(e,t,n,s,i,o){this.localStore=e,this.remoteStore=t,this.eventManager=n,this.sharedClientState=s,this.currentUser=i,this.maxConcurrentLimboResolutions=o,this.Pu={},this.Tu=new qe((a=>Lu(a)),lr),this.Iu=new Map,this.Eu=new Set,this.Ru=new U(E.comparator),this.Au=new Map,this.Vu=new Ni,this.du={},this.mu=new Map,this.fu=Ct.ar(),this.onlineState="Unknown",this.gu=void 0}get isPrimaryClient(){return this.gu===!0}}async function Bf(r,e,t=!0){const n=ys(r);let s;const i=n.Tu.get(e);return i?(n.sharedClientState.addLocalQueryTarget(i.targetId),s=i.view.lu()):s=await tl(n,e,t,!0),s}async function zf(r,e){const t=ys(r);await tl(t,e,!0,!1)}async function tl(r,e,t,n){const s=await dn(r.localStore,he(e)),i=s.targetId,o=r.sharedClientState.addLocalQueryTarget(i,t);let a;return n&&(a=await Ji(r,e,i,o==="current",s.resumeToken)),r.isPrimaryClient&&t&&ps(r.remoteStore,s),a}async function Ji(r,e,t,n,s){r.pu=(h,d,_)=>(async function(I,T,V,S){let b=T.view.ru(V);b.Ss&&(b=await Jr(I.localStore,T.query,!1).then((({documents:de})=>T.view.ru(de,b))));const Q=S&&S.targetChanges.get(T.targetId),z=S&&S.targetMismatches.get(T.targetId)!=null,Z=T.view.applyChanges(b,I.isPrimaryClient,Q,z);return ui(I,T.targetId,Z.au),Z.snapshot})(r,h,d,_);const i=await Jr(r.localStore,e,!0),o=new el(e,i.ks),a=o.ru(i.documents),u=mr.createSynthesizedTargetChangeForCurrentChange(t,n&&r.onlineState!=="Offline",s),c=o.applyChanges(a,r.isPrimaryClient,u);ui(r,t,c.au);const l=new Lf(e,t,o);return r.Tu.set(e,l),r.Iu.has(t)?r.Iu.get(t).push(e):r.Iu.set(t,[e]),c.snapshot}async function Gf(r,e,t){const n=w(r),s=n.Tu.get(e),i=n.Iu.get(s.targetId);if(i.length>1)return n.Iu.set(s.targetId,i.filter((o=>!lr(o,e)))),void n.Tu.delete(e);n.isPrimaryClient?(n.sharedClientState.removeLocalQueryTarget(s.targetId),n.sharedClientState.isActiveQueryTarget(s.targetId)||await fn(n.localStore,s.targetId,!1).then((()=>{n.sharedClientState.clearQueryState(s.targetId),t&&mn(n.remoteStore,s.targetId),_n(n,s.targetId)})).catch(it)):(_n(n,s.targetId),await fn(n.localStore,s.targetId,!0))}async function $f(r,e){const t=w(r),n=t.Tu.get(e),s=t.Iu.get(n.targetId);t.isPrimaryClient&&s.length===1&&(t.sharedClientState.removeLocalQueryTarget(n.targetId),mn(t.remoteStore,n.targetId))}async function Kf(r,e,t){const n=eo(r);try{const s=await(function(o,a){const u=w(o),c=F.now(),l=a.reduce(((_,y)=>_.add(y.key)),C());let h,d;return u.persistence.runTransaction("Locally write mutations","readwrite",(_=>{let y=_e(),I=C();return u.xs.getEntries(_,l).next((T=>{y=T,y.forEach(((V,S)=>{S.isValidDocument()||(I=I.add(V))}))})).next((()=>u.localDocuments.getOverlayedDocuments(_,y))).next((T=>{h=T;const V=[];for(const S of a){const b=fd(S,h.get(S.key).overlayedDocument);b!=null&&V.push(new Ue(S.key,b,Pu(b.value.mapValue),K.exists(!0)))}return u.mutationQueue.addMutationBatch(_,c,V,a)})).next((T=>{d=T;const V=T.applyToLocalDocumentSet(h,I);return u.documentOverlayCache.saveOverlays(_,T.batchId,V)}))})).then((()=>({batchId:d.batchId,changes:zu(h)})))})(n.localStore,e);n.sharedClientState.addPendingMutation(s.batchId),(function(o,a,u){let c=o.du[o.currentUser.toKey()];c||(c=new U(P)),c=c.insert(a,u),o.du[o.currentUser.toKey()]=c})(n,s.batchId,t),await Be(n,s.changes),await An(n.remoteStore)}catch(s){const i=Rn(s,"Failed to persist write");t.reject(i)}}async function nl(r,e){const t=w(r);try{const n=await uf(t.localStore,e);e.targetChanges.forEach(((s,i)=>{const o=t.Au.get(i);o&&(v(s.addedDocuments.size+s.modifiedDocuments.size+s.removedDocuments.size<=1,22616),s.addedDocuments.size>0?o.hu=!0:s.modifiedDocuments.size>0?v(o.hu,14607):s.removedDocuments.size>0&&(v(o.hu,42227),o.hu=!1))})),await Be(t,n,e)}catch(n){await it(n)}}function ba(r,e,t){const n=w(r);if(n.isPrimaryClient&&t===0||!n.isPrimaryClient&&t===1){const s=[];n.Tu.forEach(((i,o)=>{const a=o.view.va(e);a.snapshot&&s.push(a.snapshot)})),(function(o,a){const u=w(o);u.onlineState=a;let c=!1;u.queries.forEach(((l,h)=>{for(const d of h.ba)d.va(a)&&(c=!0)})),c&&ji(u)})(n.eventManager,e),s.length&&n.Pu.J_(s),n.onlineState=e,n.isPrimaryClient&&n.sharedClientState.setOnlineState(e)}}async function Qf(r,e,t){const n=w(r);n.sharedClientState.updateQueryState(e,"rejected",t);const s=n.Au.get(e),i=s&&s.key;if(i){let o=new U(E.comparator);o=o.insert(i,B.newNoDocument(i,R.min()));const a=C().add(i),u=new fr(R.min(),new Map,new U(P),o,a);await nl(n,u),n.Ru=n.Ru.remove(i),n.Au.delete(e),Zi(n)}else await fn(n.localStore,e,!1).then((()=>_n(n,e,t))).catch(it)}async function jf(r,e){const t=w(r),n=e.batch.batchId;try{const s=await af(t.localStore,e);Xi(t,n,null),Yi(t,n),t.sharedClientState.updateMutationState(n,"acknowledged"),await Be(t,s)}catch(s){await it(s)}}async function Wf(r,e,t){const n=w(r);try{const s=await(function(o,a){const u=w(o);return u.persistence.runTransaction("Reject batch","readwrite-primary",(c=>{let l;return u.mutationQueue.lookupMutationBatch(c,a).next((h=>(v(h!==null,37113),l=h.keys(),u.mutationQueue.removeMutationBatch(c,h)))).next((()=>u.mutationQueue.performConsistencyCheck(c))).next((()=>u.documentOverlayCache.removeOverlaysForBatchId(c,l,a))).next((()=>u.localDocuments.recalculateAndSaveOverlaysForDocumentKeys(c,l))).next((()=>u.localDocuments.getDocuments(c,l)))}))})(n.localStore,e);Xi(n,e,t),Yi(n,e),n.sharedClientState.updateMutationState(e,"rejected",t),await Be(n,s)}catch(s){await it(s)}}async function Hf(r,e){const t=w(r);ut(t.remoteStore)||p(ct,"The network is disabled. The task returned by 'awaitPendingWrites()' will not complete until the network is enabled.");try{const n=await(function(o){const a=w(o);return a.persistence.runTransaction("Get highest unacknowledged batch id","readonly",(u=>a.mutationQueue.getHighestUnacknowledgedBatchId(u)))})(t.localStore);if(n===Ye)return void e.resolve();const s=t.mu.get(n)||[];s.push(e),t.mu.set(n,s)}catch(n){const s=Rn(n,"Initialization of waitForPendingWrites() operation failed");e.reject(s)}}function Yi(r,e){(r.mu.get(e)||[]).forEach((t=>{t.resolve()})),r.mu.delete(e)}function Xi(r,e,t){const n=w(r);let s=n.du[n.currentUser.toKey()];if(s){const i=s.get(e);i&&(t?i.reject(t):i.resolve(),s=s.remove(e)),n.du[n.currentUser.toKey()]=s}}function _n(r,e,t=null){r.sharedClientState.removeLocalQueryTarget(e);for(const n of r.Iu.get(e))r.Tu.delete(n),t&&r.Pu.yu(n,t);r.Iu.delete(e),r.isPrimaryClient&&r.Vu.Gr(e).forEach((n=>{r.Vu.containsKey(n)||rl(r,n)}))}function rl(r,e){r.Eu.delete(e.path.canonicalString());const t=r.Ru.get(e);t!==null&&(mn(r.remoteStore,t),r.Ru=r.Ru.remove(e),r.Au.delete(t),Zi(r))}function ui(r,e,t){for(const n of t)n instanceof Xc?(r.Vu.addReference(n.key,e),Jf(r,n)):n instanceof Zc?(p(ct,"Document no longer in limbo: "+n.key),r.Vu.removeReference(n.key,e),r.Vu.containsKey(n.key)||rl(r,n.key)):A(19791,{wu:n})}function Jf(r,e){const t=e.key,n=t.path.canonicalString();r.Ru.get(t)||r.Eu.has(n)||(p(ct,"New document in limbo: "+t),r.Eu.add(n),Zi(r))}function Zi(r){for(;r.Eu.size>0&&r.Ru.size<r.maxConcurrentLimboResolutions;){const e=r.Eu.values().next().value;r.Eu.delete(e);const t=new E(x.fromString(e)),n=r.fu.next();r.Au.set(n,new qf(t)),r.Ru=r.Ru.insert(t,n),ps(r.remoteStore,new ke(he(In(t.path)),n,"TargetPurposeLimboResolution",fe.ce))}}async function Be(r,e,t){const n=w(r),s=[],i=[],o=[];n.Tu.isEmpty()||(n.Tu.forEach(((a,u)=>{o.push(n.pu(u,e,t).then((c=>{var l;if((c||t)&&n.isPrimaryClient){const h=c?!c.fromCache:(l=t==null?void 0:t.targetChanges.get(u.targetId))==null?void 0:l.current;n.sharedClientState.updateQueryState(u.targetId,h?"current":"not-current")}if(c){s.push(c);const h=Oi.Es(u.targetId,c);i.push(h)}})))})),await Promise.all(o),n.Pu.J_(s),await(async function(u,c){const l=w(u);try{await l.persistence.runTransaction("notifyLocalViewChanges","readwrite",(h=>f.forEach(c,(d=>f.forEach(d.Ts,(_=>l.persistence.referenceDelegate.addReference(h,d.targetId,_))).next((()=>f.forEach(d.Is,(_=>l.persistence.referenceDelegate.removeReference(h,d.targetId,_)))))))))}catch(h){if(!ot(h))throw h;p(Li,"Failed to update sequence numbers: "+h)}for(const h of c){const d=h.targetId;if(!h.fromCache){const _=l.vs.get(d),y=_.snapshotVersion,I=_.withLastLimboFreeSnapshotVersion(y);l.vs=l.vs.insert(d,I)}}})(n.localStore,i))}async function Yf(r,e){const t=w(r);if(!t.currentUser.isEqual(e)){p(ct,"User change. New user:",e.toKey());const n=await Nc(t.localStore,e);t.currentUser=e,(function(i,o){i.mu.forEach((a=>{a.forEach((u=>{u.reject(new g(m.CANCELLED,o))}))})),i.mu.clear()})(t,"'waitForPendingWrites' promise is rejected due to a user change."),t.sharedClientState.handleUserChange(e,n.removedBatchIds,n.addedBatchIds),await Be(t,n.Ns)}}function Xf(r,e){const t=w(r),n=t.Au.get(e);if(n&&n.hu)return C().add(n.key);{let s=C();const i=t.Iu.get(e);if(!i)return s;for(const o of i){const a=t.Tu.get(o);s=s.unionWith(a.view.nu)}return s}}async function Zf(r,e){const t=w(r),n=await Jr(t.localStore,e.query,!0),s=e.view.cu(n);return t.isPrimaryClient&&ui(t,e.targetId,s.au),s}async function em(r,e){const t=w(r);return Oc(t.localStore,e).then((n=>Be(t,n)))}async function tm(r,e,t,n){const s=w(r),i=await(function(a,u){const c=w(a),l=w(c.mutationQueue);return c.persistence.runTransaction("Lookup mutation documents","readonly",(h=>l.Xn(h,u).next((d=>d?c.localDocuments.getDocuments(h,d):f.resolve(null)))))})(s.localStore,e);i!==null?(t==="pending"?await An(s.remoteStore):t==="acknowledged"||t==="rejected"?(Xi(s,e,n||null),Yi(s,e),(function(a,u){w(w(a).mutationQueue).nr(u)})(s.localStore,e)):A(6720,"Unknown batchState",{bu:t}),await Be(s,i)):p(ct,"Cannot apply mutation batch with id: "+e)}async function nm(r,e){const t=w(r);if(ys(t),eo(t),e===!0&&t.gu!==!0){const n=t.sharedClientState.getAllActiveQueryTargets(),s=await Sa(t,n.toArray());t.gu=!0,await oi(t.remoteStore,!0);for(const i of s)ps(t.remoteStore,i)}else if(e===!1&&t.gu!==!1){const n=[];let s=Promise.resolve();t.Iu.forEach(((i,o)=>{t.sharedClientState.isLocalQueryTarget(o)?n.push(o):s=s.then((()=>(_n(t,o),fn(t.localStore,o,!0)))),mn(t.remoteStore,o)})),await s,await Sa(t,n),(function(o){const a=w(o);a.Au.forEach(((u,c)=>{mn(a.remoteStore,c)})),a.Vu.zr(),a.Au=new Map,a.Ru=new U(E.comparator)})(t),t.gu=!1,await oi(t.remoteStore,!1)}}async function Sa(r,e,t){const n=w(r),s=[],i=[];for(const o of e){let a;const u=n.Iu.get(o);if(u&&u.length!==0){a=await dn(n.localStore,he(u[0]));for(const c of u){const l=n.Tu.get(c),h=await Zf(n,l);h.snapshot&&i.push(h.snapshot)}}else{const c=await Mc(n.localStore,o);a=await dn(n.localStore,c),await Ji(n,sl(c),o,!1,a.resumeToken)}s.push(a)}return n.Pu.J_(i),s}function sl(r){return Fu(r.path,r.collectionGroup,r.orderBy,r.filters,r.limit,"F",r.startAt,r.endAt)}function rm(r){return(function(t){return w(w(t).persistence).hs()})(w(r).localStore)}async function sm(r,e,t,n){const s=w(r);if(s.gu)return void p(ct,"Ignoring unexpected query state notification.");const i=s.Iu.get(e);if(i&&i.length>0)switch(t){case"current":case"not-current":{const o=await Oc(s.localStore,qu(i[0])),a=fr.createSynthesizedRemoteEventForCurrentChange(e,t==="current",W.EMPTY_BYTE_STRING);await Be(s,o,a);break}case"rejected":await fn(s.localStore,e,!0),_n(s,e,n);break;default:A(64155,t)}}async function im(r,e,t){const n=ys(r);if(n.gu){for(const s of e){if(n.Iu.has(s)&&n.sharedClientState.isActiveQueryTarget(s)){p(ct,"Adding an already active target "+s);continue}const i=await Mc(n.localStore,s),o=await dn(n.localStore,i);await Ji(n,sl(i),o.targetId,!1,o.resumeToken),ps(n.remoteStore,o)}for(const s of t)n.Iu.has(s)&&await fn(n.localStore,s,!1).then((()=>{mn(n.remoteStore,s),_n(n,s)})).catch(it)}}function ys(r){const e=w(r);return e.remoteStore.remoteSyncer.applyRemoteEvent=nl.bind(null,e),e.remoteStore.remoteSyncer.getRemoteKeysForTarget=Xf.bind(null,e),e.remoteStore.remoteSyncer.rejectListen=Qf.bind(null,e),e.Pu.J_=Mf.bind(null,e.eventManager),e.Pu.yu=Of.bind(null,e.eventManager),e}function eo(r){const e=w(r);return e.remoteStore.remoteSyncer.applySuccessfulWrite=jf.bind(null,e),e.remoteStore.remoteSyncer.rejectFailedWrite=Wf.bind(null,e),e}function om(r,e,t){const n=w(r);(async function(i,o,a){try{const u=await o.getMetadata();if(await(function(_,y){const I=w(_),T=J(y.createTime);return I.persistence.runTransaction("hasNewerBundle","readonly",(V=>I.Pi.getBundleMetadata(V,y.id))).then((V=>!!V&&V.createTime.compareTo(T)>=0))})(i.localStore,u))return await o.close(),a._completeWith((function(_){return{taskState:"Success",documentsLoaded:_.totalDocuments,bytesLoaded:_.totalBytes,totalDocuments:_.totalDocuments,totalBytes:_.totalBytes}})(u)),Promise.resolve(new Set);a._updateProgress(Yc(u));const c=new Hi(u,o.serializer);let l=await o.Su();for(;l;){const d=await c.Ga(l);d&&a._updateProgress(d),l=await o.Su()}const h=await c.ja(i.localStore);return await Be(i,h.Ja,void 0),await(function(_,y){const I=w(_);return I.persistence.runTransaction("Save bundle","readwrite",(T=>I.Pi.saveBundleMetadata(T,y)))})(i.localStore,u),a._completeWith(h.progress),Promise.resolve(h.Ha)}catch(u){return Te(ct,`Loading bundle failed with ${u}`),a._failWith(u),Promise.resolve(new Set)}})(n,e,t).then((s=>{n.sharedClientState.notifyBundleLoaded(s)}))}class gn{constructor(){this.kind="memory",this.synchronizeTabs=!1}async initialize(e){this.serializer=kt(e.databaseInfo.databaseId),this.sharedClientState=this.Du(e),this.persistence=this.Cu(e),await this.persistence.start(),this.localStore=this.vu(e),this.gcScheduler=this.Fu(e,this.localStore),this.indexBackfillerScheduler=this.Mu(e,this.localStore)}Fu(e,t){return null}Mu(e,t){return null}vu(e){return Dc(this.persistence,new xc,e.initialUser,this.serializer)}Cu(e){return new ki(gs.Vi,this.serializer)}Du(e){return new zc}async terminate(){var e,t;(e=this.gcScheduler)==null||e.stop(),(t=this.indexBackfillerScheduler)==null||t.stop(),this.sharedClientState.shutdown(),await this.persistence.shutdown()}}gn.provider={build:()=>new gn};class to extends gn{constructor(e){super(),this.cacheSizeBytes=e}Fu(e,t){v(this.persistence.referenceDelegate instanceof Hr,46915);const n=this.persistence.referenceDelegate.garbageCollector;return new Rc(n,e.asyncQueue,t)}Cu(e){const t=this.cacheSizeBytes!==void 0?ce.withCacheSize(this.cacheSizeBytes):ce.DEFAULT;return new ki((n=>Hr.Vi(n,t)),this.serializer)}}class no extends gn{constructor(e,t,n){super(),this.xu=e,this.cacheSizeBytes=t,this.forceOwnership=n,this.kind="persistent",this.synchronizeTabs=!1}async initialize(e){await super.initialize(e),await this.xu.initialize(this,e),await eo(this.xu.syncEngine),await An(this.xu.remoteStore),await this.persistence.zi((()=>(this.gcScheduler&&!this.gcScheduler.started&&this.gcScheduler.start(),this.indexBackfillerScheduler&&!this.indexBackfillerScheduler.started&&this.indexBackfillerScheduler.start(),Promise.resolve())))}vu(e){return Dc(this.persistence,new xc,e.initialUser,this.serializer)}Fu(e,t){const n=this.persistence.referenceDelegate.garbageCollector;return new Rc(n,e.asyncQueue,t)}Mu(e,t){const n=new fh(t,this.persistence);return new dh(e.asyncQueue,n)}Cu(e){const t=Mi(e.databaseInfo.databaseId,e.databaseInfo.persistenceKey),n=this.cacheSizeBytes!==void 0?ce.withCacheSize(this.cacheSizeBytes):ce.DEFAULT;return new Fi(this.synchronizeTabs,t,e.clientId,n,e.asyncQueue,Gc(),Or(),this.serializer,this.sharedClientState,!!this.forceOwnership)}Du(e){return new zc}}class il extends no{constructor(e,t){super(e,t,!1),this.xu=e,this.cacheSizeBytes=t,this.synchronizeTabs=!0}async initialize(e){await super.initialize(e);const t=this.xu.syncEngine;this.sharedClientState instanceof ks&&(this.sharedClientState.syncEngine={So:tm.bind(null,t),Do:sm.bind(null,t),Co:im.bind(null,t),hs:rm.bind(null,t),bo:em.bind(null,t)},await this.sharedClientState.start()),await this.persistence.zi((async n=>{await nm(this.xu.syncEngine,n),this.gcScheduler&&(n&&!this.gcScheduler.started?this.gcScheduler.start():n||this.gcScheduler.stop()),this.indexBackfillerScheduler&&(n&&!this.indexBackfillerScheduler.started?this.indexBackfillerScheduler.start():n||this.indexBackfillerScheduler.stop())}))}Du(e){const t=Gc();if(!ks.v(t))throw new g(m.UNIMPLEMENTED,"IndexedDB persistence is only available on platforms that support LocalStorage.");const n=Mi(e.databaseInfo.databaseId,e.databaseInfo.persistenceKey);return new ks(t,e.asyncQueue,n,e.clientId,e.initialUser)}}class rt{async initialize(e,t){this.localStore||(this.localStore=e.localStore,this.sharedClientState=e.sharedClientState,this.datastore=this.createDatastore(t),this.remoteStore=this.createRemoteStore(t),this.eventManager=this.createEventManager(t),this.syncEngine=this.createSyncEngine(t,!e.synchronizeTabs),this.sharedClientState.onlineStateHandler=n=>ba(this.syncEngine,n,1),this.remoteStore.remoteSyncer.handleCredentialChange=Yf.bind(null,this.syncEngine),await oi(this.remoteStore,this.syncEngine.isPrimaryClient))}createEventManager(e){return(function(){return new Ff})()}createDatastore(e){const t=kt(e.databaseInfo.databaseId),n=gf(e.databaseInfo);return Ef(e.authCredentials,e.appCheckCredentials,n,t)}createRemoteStore(e){return(function(n,s,i,o,a){return new Af(n,s,i,o,a)})(this.localStore,this.datastore,e.asyncQueue,(t=>ba(this.syncEngine,t,0)),(function(){return Ea.v()?new Ea:new df})())}createSyncEngine(e,t){return(function(s,i,o,a,u,c,l){const h=new Uf(s,i,o,a,u,c);return l&&(h.gu=!0),h})(this.localStore,this.remoteStore,this.eventManager,this.sharedClientState,e.initialUser,e.maxConcurrentLimboResolutions,t)}async terminate(){var e,t;await(async function(s){const i=w(s);p(xt,"RemoteStore shutting down."),i.Ea.add(5),await wn(i),i.Aa.shutdown(),i.Va.set("Unknown")})(this.remoteStore),(e=this.datastore)==null||e.terminate(),(t=this.eventManager)==null||t.terminate()}}rt.provider={build:()=>new rt};function Ca(r,e=10240){let t=0;return{async read(){if(t<r.byteLength){const n={value:r.slice(t,t+e),done:!1};return t+=e,n}return{done:!0}},async cancel(){},releaseLock(){},closed:Promise.resolve()}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *//**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Is{constructor(e){this.observer=e,this.muted=!1}next(e){this.muted||this.observer.next&&this.Ou(this.observer.next,e)}error(e){this.muted||(this.observer.error?this.Ou(this.observer.error,e):H("Uncaught Error in snapshot listener:",e.toString()))}Nu(){this.muted=!0}Ou(e,t){setTimeout((()=>{this.muted||e(t)}),0)}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class am{constructor(e,t){this.Bu=e,this.serializer=t,this.metadata=new ie,this.buffer=new Uint8Array,this.Lu=(function(){return new TextDecoder("utf-8")})(),this.ku().then((n=>{n&&n.Ua()?this.metadata.resolve(n.qa.metadata):this.metadata.reject(new Error(`The first element of the bundle is not a metadata, it is
             ${JSON.stringify(n==null?void 0:n.qa)}`))}),(n=>this.metadata.reject(n)))}close(){return this.Bu.cancel()}async getMetadata(){return this.metadata.promise}async Su(){return await this.getMetadata(),this.ku()}async ku(){const e=await this.Ku();if(e===null)return null;const t=this.Lu.decode(e),n=Number(t);isNaN(n)&&this.qu(`length string (${t}) is not valid number`);const s=await this.Uu(n);return new Jc(JSON.parse(s),e.length+n)}$u(){return this.buffer.findIndex((e=>e===123))}async Ku(){for(;this.$u()<0&&!await this.Wu(););if(this.buffer.length===0)return null;const e=this.$u();e<0&&this.qu("Reached the end of bundle when a length string is expected.");const t=this.buffer.slice(0,e);return this.buffer=this.buffer.slice(e),t}async Uu(e){for(;this.buffer.length<e;)await this.Wu()&&this.qu("Reached the end of bundle when more is expected.");const t=this.Lu.decode(this.buffer.slice(0,e));return this.buffer=this.buffer.slice(e),t}qu(e){throw this.Bu.cancel(),new Error(`Invalid bundle format: ${e}`)}async Wu(){const e=await this.Bu.read();if(!e.done){const t=new Uint8Array(this.buffer.length+e.value.length);t.set(this.buffer),t.set(e.value,this.buffer.length),this.buffer=t}return e.done}}/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class um{constructor(e,t){this.bundleData=e,this.serializer=t,this.cursor=0,this.elements=[];let n=this.Su();if(!n||!n.Ua())throw new Error(`The first element of the bundle is not a metadata object, it is
         ${JSON.stringify(n==null?void 0:n.qa)}`);this.metadata=n;do n=this.Su(),n!==null&&this.elements.push(n);while(n!==null)}getMetadata(){return this.metadata}Qu(){return this.elements}Su(){if(this.cursor===this.bundleData.length)return null;const e=this.Ku(),t=this.Uu(e);return new Jc(JSON.parse(t),e)}Uu(e){if(this.cursor+e>this.bundleData.length)throw new g(m.INTERNAL,"Reached the end of bundle when more is expected.");return this.bundleData.slice(this.cursor,this.cursor+=e)}Ku(){const e=this.cursor;let t=this.cursor;for(;t<this.bundleData.length;){if(this.bundleData[t]==="{"){if(t===e)throw new Error("First character is a bracket and not a number");return this.cursor=t,Number(this.bundleData.slice(e,t))}t++}throw new Error("Reached the end of bundle when more is expected.")}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */let cm=class{constructor(e){this.datastore=e,this.readVersions=new Map,this.mutations=[],this.committed=!1,this.lastTransactionError=null,this.writtenDocs=new Set}async lookup(e){if(this.ensureCommitNotCalled(),this.mutations.length>0)throw this.lastTransactionError=new g(m.INVALID_ARGUMENT,"Firestore transactions require all reads to be executed before all writes."),this.lastTransactionError;const t=await(async function(s,i){const o=w(s),a={documents:i.map((h=>nr(o.serializer,h)))},u=await o.jo("BatchGetDocuments",o.serializer.databaseId,x.emptyPath(),a,i.length),c=new Map;u.forEach((h=>{const d=Ad(o.serializer,h);c.set(d.key.toString(),d)}));const l=[];return i.forEach((h=>{const d=c.get(h.toString());v(!!d,55234,{key:h}),l.push(d)})),l})(this.datastore,e);return t.forEach((n=>this.recordVersion(n))),t}set(e,t){this.write(t.toMutation(e,this.precondition(e))),this.writtenDocs.add(e.toString())}update(e,t){try{this.write(t.toMutation(e,this.preconditionForUpdate(e)))}catch(n){this.lastTransactionError=n}this.writtenDocs.add(e.toString())}delete(e){this.write(new En(e,this.precondition(e))),this.writtenDocs.add(e.toString())}async commit(){if(this.ensureCommitNotCalled(),this.lastTransactionError)throw this.lastTransactionError;const e=this.readVersions;this.mutations.forEach((t=>{e.delete(t.key.toString())})),e.forEach(((t,n)=>{const s=E.fromPath(n);this.mutations.push(new Ri(s,this.precondition(s)))})),await(async function(n,s){const i=w(n),o={writes:s.map((a=>rr(i.serializer,a)))};await i.Wo("Commit",i.serializer.databaseId,x.emptyPath(),o)})(this.datastore,this.mutations),this.committed=!0}recordVersion(e){let t;if(e.isFoundDocument())t=e.version;else{if(!e.isNoDocument())throw A(50498,{Gu:e.constructor.name});t=R.min()}const n=this.readVersions.get(e.key.toString());if(n){if(!t.isEqual(n))throw new g(m.ABORTED,"Document version changed between two reads.")}else this.readVersions.set(e.key.toString(),t)}precondition(e){const t=this.readVersions.get(e.toString());return!this.writtenDocs.has(e.toString())&&t?t.isEqual(R.min())?K.exists(!1):K.updateTime(t):K.none()}preconditionForUpdate(e){const t=this.readVersions.get(e.toString());if(!this.writtenDocs.has(e.toString())&&t){if(t.isEqual(R.min()))throw new g(m.INVALID_ARGUMENT,"Can't update a document that doesn't exist.");return K.updateTime(t)}return K.exists(!0)}write(e){this.ensureCommitNotCalled(),this.mutations.push(e)}ensureCommitNotCalled(){}};/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class lm{constructor(e,t,n,s,i){this.asyncQueue=e,this.datastore=t,this.options=n,this.updateFunction=s,this.deferred=i,this.zu=n.maxAttempts,this.M_=new Ui(this.asyncQueue,"transaction_retry")}ju(){this.zu-=1,this.Hu()}Hu(){this.M_.p_((async()=>{const e=new cm(this.datastore),t=this.Ju(e);t&&t.then((n=>{this.asyncQueue.enqueueAndForget((()=>e.commit().then((()=>{this.deferred.resolve(n)})).catch((s=>{this.Zu(s)}))))})).catch((n=>{this.Zu(n)}))}))}Ju(e){try{const t=this.updateFunction(e);return!ar(t)&&t.catch&&t.then?t:(this.deferred.reject(Error("Transaction callback must return a Promise")),null)}catch(t){return this.deferred.reject(t),null}}Zu(e){this.zu>0&&this.Xu(e)?(this.zu-=1,this.asyncQueue.enqueueAndForget((()=>(this.Hu(),Promise.resolve())))):this.deferred.reject(e)}Xu(e){if((e==null?void 0:e.name)==="FirebaseError"){const t=e.code;return t==="aborted"||t==="failed-precondition"||t==="already-exists"||!Zu(t)}return!1}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const st="FirestoreClient";class hm{constructor(e,t,n,s,i){this.authCredentials=e,this.appCheckCredentials=t,this.asyncQueue=n,this._databaseInfo=s,this.user=re.UNAUTHENTICATED,this.clientId=hi.newId(),this.authCredentialListener=()=>Promise.resolve(),this.appCheckCredentialListener=()=>Promise.resolve(),this._uninitializedComponentsProvider=i,this.authCredentials.start(n,(async o=>{p(st,"Received user=",o.uid),await this.authCredentialListener(o),this.user=o})),this.appCheckCredentials.start(n,(o=>(p(st,"Received new app check token=",o),this.appCheckCredentialListener(o,this.user))))}get configuration(){return{asyncQueue:this.asyncQueue,databaseInfo:this._databaseInfo,clientId:this.clientId,authCredentials:this.authCredentials,appCheckCredentials:this.appCheckCredentials,initialUser:this.user,maxConcurrentLimboResolutions:100}}setCredentialChangeListener(e){this.authCredentialListener=e}setAppCheckTokenChangeListener(e){this.appCheckCredentialListener=e}terminate(){this.asyncQueue.enterRestrictedMode();const e=new ie;return this.asyncQueue.enqueueAndForgetEvenWhileRestricted((async()=>{try{this._onlineComponents&&await this._onlineComponents.terminate(),this._offlineComponents&&await this._offlineComponents.terminate(),this.authCredentials.shutdown(),this.appCheckCredentials.shutdown(),e.resolve()}catch(t){const n=Rn(t,"Failed to shutdown persistence");e.reject(n)}})),e.promise}}async function Ms(r,e){r.asyncQueue.verifyOperationInProgress(),p(st,"Initializing OfflineComponentProvider");const t=r.configuration;await e.initialize(t);let n=t.initialUser;r.setCredentialChangeListener((async s=>{n.isEqual(s)||(await Nc(e.localStore,s),n=s)})),e.persistence.setDatabaseDeletedListener((()=>r.terminate())),r._offlineComponents=e}async function xa(r,e){r.asyncQueue.verifyOperationInProgress();const t=await ro(r);p(st,"Initializing OnlineComponentProvider"),await e.initialize(t,r.configuration),r.setCredentialChangeListener((n=>Aa(e.remoteStore,n))),r.setAppCheckTokenChangeListener(((n,s)=>Aa(e.remoteStore,s))),r._onlineComponents=e}async function ro(r){if(!r._offlineComponents)if(r._uninitializedComponentsProvider){p(st,"Using user provided OfflineComponentProvider");try{await Ms(r,r._uninitializedComponentsProvider._offline)}catch(e){const t=e;if(!(function(s){return s.name==="FirebaseError"?s.code===m.FAILED_PRECONDITION||s.code===m.UNIMPLEMENTED:!(typeof DOMException<"u"&&s instanceof DOMException)||s.code===22||s.code===20||s.code===11})(t))throw t;Te("Error using user provided cache. Falling back to memory cache: "+t),await Ms(r,new gn)}}else p(st,"Using default OfflineComponentProvider"),await Ms(r,new to(void 0));return r._offlineComponents}async function Ts(r){return r._onlineComponents||(r._uninitializedComponentsProvider?(p(st,"Using user provided OnlineComponentProvider"),await xa(r,r._uninitializedComponentsProvider._online)):(p(st,"Using default OnlineComponentProvider"),await xa(r,new rt))),r._onlineComponents}function ol(r){return ro(r).then((e=>e.persistence))}function Vn(r){return ro(r).then((e=>e.localStore))}function al(r){return Ts(r).then((e=>e.remoteStore))}function so(r){return Ts(r).then((e=>e.syncEngine))}function ul(r){return Ts(r).then((e=>e.datastore))}async function pn(r){const e=await Ts(r),t=e.eventManager;return t.onListen=Bf.bind(null,e.syncEngine),t.onUnlisten=Gf.bind(null,e.syncEngine),t.onFirstRemoteStoreListen=zf.bind(null,e.syncEngine),t.onLastRemoteStoreUnlisten=$f.bind(null,e.syncEngine),t}function dm(r){return r.asyncQueue.enqueue((async()=>{const e=await ol(r),t=await al(r);return e.setNetworkEnabled(!0),(function(s){const i=w(s);return i.Ea.delete(0),_r(i)})(t)}))}function fm(r){return r.asyncQueue.enqueue((async()=>{const e=await ol(r),t=await al(r);return e.setNetworkEnabled(!1),(async function(s){const i=w(s);i.Ea.add(0),await wn(i),i.Va.set("Offline")})(t)}))}function mm(r,e,t,n){const s=new Is(n),i=new Wi(e,s,t);return r.asyncQueue.enqueueAndForget((async()=>Ki(await pn(r),i))),()=>{s.Nu(),r.asyncQueue.enqueueAndForget((async()=>Qi(await pn(r),i)))}}function _m(r,e){const t=new ie;return r.asyncQueue.enqueueAndForget((async()=>(async function(s,i,o){try{const a=await(function(c,l){const h=w(c);return h.persistence.runTransaction("read document","readonly",(d=>h.localDocuments.getDocument(d,l)))})(s,i);a.isFoundDocument()?o.resolve(a):a.isNoDocument()?o.resolve(null):o.reject(new g(m.UNAVAILABLE,"Failed to get document from cache. (However, this document may exist on the server. Run again without setting 'source' in the GetOptions to attempt to retrieve the document from the server.)"))}catch(a){const u=Rn(a,`Failed to get document '${i} from cache`);o.reject(u)}})(await Vn(r),e,t))),t.promise}function cl(r,e,t={}){const n=new ie;return r.asyncQueue.enqueueAndForget((async()=>(function(i,o,a,u,c){const l=new Is({next:d=>{l.Nu(),o.enqueueAndForget((()=>Qi(i,h)));const _=d.docs.has(a);!_&&d.fromCache?c.reject(new g(m.UNAVAILABLE,"Failed to get document because the client is offline.")):_&&d.fromCache&&u&&u.source==="server"?c.reject(new g(m.UNAVAILABLE,'Failed to get document from server. (However, this document does exist in the local cache. Run again without setting source to "server" to retrieve the cached document.)')):c.resolve(d)},error:d=>c.reject(d)}),h=new Wi(In(a.path),l,{includeMetadataChanges:!0,Ka:!0});return Ki(i,h)})(await pn(r),r.asyncQueue,e,t,n))),n.promise}function gm(r,e){const t=new ie;return r.asyncQueue.enqueueAndForget((async()=>(async function(s,i,o){try{const a=await Jr(s,i,!0),u=new el(i,a.ks),c=u.ru(a.documents),l=u.applyChanges(c,!1);o.resolve(l.snapshot)}catch(a){const u=Rn(a,`Failed to execute query '${i} against cache`);o.reject(u)}})(await Vn(r),e,t))),t.promise}function ll(r,e,t={}){const n=new ie;return r.asyncQueue.enqueueAndForget((async()=>(function(i,o,a,u,c){const l=new Is({next:d=>{l.Nu(),o.enqueueAndForget((()=>Qi(i,h))),d.fromCache&&u.source==="server"?c.reject(new g(m.UNAVAILABLE,'Failed to get documents from server. (However, these documents may exist in the local cache. Run again without setting source to "server" to retrieve the cached documents.)')):c.resolve(d)},error:d=>c.reject(d)}),h=new Wi(a,l,{includeMetadataChanges:!0,Ka:!0});return Ki(i,h)})(await pn(r),r.asyncQueue,e,t,n))),n.promise}function pm(r,e,t){const n=new ie;return r.asyncQueue.enqueueAndForget((async()=>{try{const s=await ul(r);n.resolve((async function(o,a,u){var I;const c=w(o),{request:l,gt:h,parent:d}=lc(c.serializer,Mu(a),u);c.connection.Ko||delete l.parent;const _=(await c.jo("RunAggregationQuery",c.serializer.databaseId,d,l,1)).filter((T=>!!T.result));v(_.length===1,64727);const y=(I=_[0].result)==null?void 0:I.aggregateFields;return Object.keys(y).reduce(((T,V)=>(T[h[V]]=y[V],T)),{})})(s,e,t))}catch(s){n.reject(s)}})),n.promise}function ym(r,e){const t=new ie;return r.asyncQueue.enqueueAndForget((async()=>Kf(await so(r),e,t))),t.promise}function Im(r,e){const t=new Is(e);return r.asyncQueue.enqueueAndForget((async()=>(function(s,i){w(s).Ca.add(i),i.next()})(await pn(r),t))),()=>{t.Nu(),r.asyncQueue.enqueueAndForget((async()=>(function(s,i){w(s).Ca.delete(i)})(await pn(r),t)))}}function Tm(r,e,t){const n=new ie;return r.asyncQueue.enqueueAndForget((async()=>{const s=await ul(r);new lm(r.asyncQueue,s,t,e,n).ju()})),n.promise}function Em(r,e,t,n){const s=(function(o,a){let u;return u=typeof o=="string"?tc().encode(o):o,(function(l,h){return new am(l,h)})((function(l,h){if(l instanceof Uint8Array)return Ca(l,h);if(l instanceof ArrayBuffer)return Ca(new Uint8Array(l),h);if(l instanceof ReadableStream)return l.getReader();throw new Error("Source of `toByteStreamReader` has to be a ArrayBuffer or ReadableStream")})(u),a)})(t,kt(e));r.asyncQueue.enqueueAndForget((async()=>{om(await so(r),s,n)}))}function wm(r,e){return r.asyncQueue.enqueue((async()=>(function(n,s){const i=w(n);return i.persistence.runTransaction("Get named query","readonly",(o=>i.Pi.getNamedQuery(o,s)))})(await Vn(r),e)))}function hl(r,e){return(function(n,s){return new um(n,s)})(r,e)}function Am(r,e){return r.asyncQueue.enqueue((async()=>(async function(n,s){const i=w(n),o=i.indexManager,a=[];return i.persistence.runTransaction("Configure indexes","readwrite",(u=>o.getFieldIndexes(u).next((c=>(function(h,d,_,y,I){h=[...h],d=[...d],h.sort(_),d.sort(_);const T=h.length,V=d.length;let S=0,b=0;for(;S<V&&b<T;){const Q=_(h[b],d[S]);Q<0?I(h[b++]):Q>0?y(d[S++]):(S++,b++)}for(;S<V;)y(d[S++]);for(;b<T;)I(h[b++])})(c,s,uh,(l=>{a.push(o.addFieldIndex(u,l))}),(l=>{a.push(o.deleteFieldIndex(u,l))})))).next((()=>f.waitFor(a)))))})(await Vn(r),e)))}function vm(r,e){return r.asyncQueue.enqueue((async()=>(function(n,s){w(n).Cs.As=s})(await Vn(r),e)))}function Rm(r){return r.asyncQueue.enqueue((async()=>(function(t){const n=w(t),s=n.indexManager;return n.persistence.runTransaction("Delete All Indexes","readwrite",(i=>s.deleteAllFieldIndexes(i)))})(await Vn(r))))}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function dl(r){const e={};return r.timeoutSeconds!==void 0&&(e.timeoutSeconds=r.timeoutSeconds),e}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Vm="ComponentProvider",Da=new Map;function Pm(r,e,t,n,s){return new Bh(r,e,t,s.host,s.ssl,s.experimentalForceLongPolling,s.experimentalAutoDetectLongPolling,dl(s.experimentalLongPollingOptions),s.useFetchStreams,s.isUsingEmulator,n)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const fl="firestore.googleapis.com",Na=!0;class ka{constructor(e){if(e.host===void 0){if(e.ssl!==void 0)throw new g(m.INVALID_ARGUMENT,"Can't provide ssl option if host option is not set");this.host=fl,this.ssl=Na}else this.host=e.host,this.ssl=e.ssl??Na;if(this.isUsingEmulator=e.emulatorOptions!==void 0,this.credentials=e.credentials,this.ignoreUndefinedProperties=!!e.ignoreUndefinedProperties,this.localCache=e.localCache,e.cacheSizeBytes===void 0)this.cacheSizeBytes=Tc;else{if(e.cacheSizeBytes!==-1&&e.cacheSizeBytes<vc)throw new g(m.INVALID_ARGUMENT,"cacheSizeBytes must be at least 1048576");this.cacheSizeBytes=e.cacheSizeBytes}ah("experimentalForceLongPolling",e.experimentalForceLongPolling,"experimentalAutoDetectLongPolling",e.experimentalAutoDetectLongPolling),this.experimentalForceLongPolling=!!e.experimentalForceLongPolling,this.experimentalForceLongPolling?this.experimentalAutoDetectLongPolling=!1:e.experimentalAutoDetectLongPolling===void 0?this.experimentalAutoDetectLongPolling=!0:this.experimentalAutoDetectLongPolling=!!e.experimentalAutoDetectLongPolling,this.experimentalLongPollingOptions=dl(e.experimentalLongPollingOptions??{}),(function(n){if(n.timeoutSeconds!==void 0){if(isNaN(n.timeoutSeconds))throw new g(m.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (must not be NaN)`);if(n.timeoutSeconds<5)throw new g(m.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (minimum allowed value is 5)`);if(n.timeoutSeconds>30)throw new g(m.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (maximum allowed value is 30)`)}})(this.experimentalLongPollingOptions),this.useFetchStreams=!!e.useFetchStreams}isEqual(e){return this.host===e.host&&this.ssl===e.ssl&&this.credentials===e.credentials&&this.cacheSizeBytes===e.cacheSizeBytes&&this.experimentalForceLongPolling===e.experimentalForceLongPolling&&this.experimentalAutoDetectLongPolling===e.experimentalAutoDetectLongPolling&&(function(n,s){return n.timeoutSeconds===s.timeoutSeconds})(this.experimentalLongPollingOptions,e.experimentalLongPollingOptions)&&this.ignoreUndefinedProperties===e.ignoreUndefinedProperties&&this.useFetchStreams===e.useFetchStreams}}class gr{constructor(e,t,n,s){this._authCredentials=e,this._appCheckCredentials=t,this._databaseId=n,this._app=s,this.type="firestore-lite",this._persistenceKey="(lite)",this._settings=new ka({}),this._settingsFrozen=!1,this._emulatorOptions={},this._terminateTask="notTerminated"}get app(){if(!this._app)throw new g(m.FAILED_PRECONDITION,"Firestore was not initialized using the Firebase SDK. 'app' is not available");return this._app}get _initialized(){return this._settingsFrozen}get _terminated(){return this._terminateTask!=="notTerminated"}_setSettings(e){if(this._settingsFrozen)throw new g(m.FAILED_PRECONDITION,"Firestore has already been started and its settings can no longer be changed. You can only modify settings before calling any other methods on a Firestore object.");this._settings=new ka(e),this._emulatorOptions=e.emulatorOptions||{},e.credentials!==void 0&&(this._authCredentials=(function(n){if(!n)return new Yl;switch(n.type){case"firstParty":return new th(n.sessionIndex||"0",n.iamToken||null,n.authTokenFactory||null);case"provider":return n.client;default:throw new g(m.INVALID_ARGUMENT,"makeAuthCredentialsProvider failed due to invalid credential type")}})(e.credentials))}_getSettings(){return this._settings}_getEmulatorOptions(){return this._emulatorOptions}_freezeSettings(){return this._settingsFrozen=!0,this._settings}_delete(){return this._terminateTask==="notTerminated"&&(this._terminateTask=this._terminate()),this._terminateTask}async _restart(){this._terminateTask==="notTerminated"?await this._terminate():this._terminateTask="notTerminated"}toJSON(){return{app:this._app,databaseId:this._databaseId,settings:this._settings}}_terminate(){return(function(t){const n=Da.get(t);n&&(p(Vm,"Removing Datastore"),Da.delete(t),n.terminate())})(this),Promise.resolve()}}function bm(r,e,t,n={}){var c;r=D(r,gr);const s=ci(e),i=r._getSettings(),o={...i,emulatorOptions:r._getEmulatorOptions()},a=`${e}:${t}`;s&&(Qa(`https://${a}`),Nl("Firestore",!0)),i.host!==fl&&i.host!==a&&Te("Host has been set in both settings() and connectFirestoreEmulator(), emulator host will be used.");const u={...i,host:a,ssl:s,emulatorOptions:n};if(!or(u,o)&&(r._setSettings(u),n.mockUserToken)){let l,h;if(typeof n.mockUserToken=="string")l=n.mockUserToken,h=re.MOCK_USER;else{l=kl(n.mockUserToken,(c=r._app)==null?void 0:c.options.projectId);const d=n.mockUserToken.sub||n.mockUserToken.user_id;if(!d)throw new g(m.INVALID_ARGUMENT,"mockUserToken must contain 'sub' or 'user_id' field!");h=new re(d)}r._authCredentials=new Xl(new Ya(l,h))}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class oe{constructor(e,t,n){this.converter=t,this._query=n,this.type="query",this.firestore=e}withConverter(e){return new oe(this.firestore,e,this._query)}}class L{constructor(e,t,n){this.converter=t,this._key=n,this.type="document",this.firestore=e}get _path(){return this._key.path}get id(){return this._key.path.lastSegment()}get path(){return this._key.path.canonicalString()}get parent(){return new Ce(this.firestore,this.converter,this._key.path.popLast())}withConverter(e){return new L(this.firestore,e,this._key)}toJSON(){return{type:L._jsonSchemaVersion,referencePath:this._key.toString()}}static fromJSON(e,t,n){if(Nt(t,L._jsonSchema))return new L(e,n||null,new E(x.fromString(t.referencePath)))}}L._jsonSchemaVersion="firestore/documentReference/1.0",L._jsonSchema={type:X("string",L._jsonSchemaVersion),referencePath:X("string")};class Ce extends oe{constructor(e,t,n){super(e,t,In(n)),this._path=n,this.type="collection"}get id(){return this._query.path.lastSegment()}get path(){return this._query.path.canonicalString()}get parent(){const e=this._path.popLast();return e.isEmpty()?null:new L(this.firestore,null,new E(e))}withConverter(e){return new Ce(this.firestore,e,this._path)}}function o_(r,e,...t){if(r=ee(r),di("collection","path",e),r instanceof gr){const n=x.fromString(e,...t);return wo(n),new Ce(r,null,n)}{if(!(r instanceof L||r instanceof Ce))throw new g(m.INVALID_ARGUMENT,"Expected first argument to collection() to be a CollectionReference, a DocumentReference or FirebaseFirestore");const n=r._path.child(x.fromString(e,...t));return wo(n),new Ce(r.firestore,null,n)}}function a_(r,e){if(r=D(r,gr),di("collectionGroup","collection id",e),e.indexOf("/")>=0)throw new g(m.INVALID_ARGUMENT,`Invalid collection ID '${e}' passed to function collectionGroup(). Collection IDs must not contain '/'.`);return new oe(r,null,(function(n){return new Le(x.emptyPath(),n)})(e))}function Sm(r,e,...t){if(r=ee(r),arguments.length===1&&(e=hi.newId()),di("doc","path",e),r instanceof gr){const n=x.fromString(e,...t);return Eo(n),new L(r,null,new E(n))}{if(!(r instanceof L||r instanceof Ce))throw new g(m.INVALID_ARGUMENT,"Expected first argument to doc() to be a CollectionReference, a DocumentReference or FirebaseFirestore");const n=r._path.child(x.fromString(e,...t));return Eo(n),new L(r.firestore,r instanceof Ce?r.converter:null,new E(n))}}function u_(r,e){return r=ee(r),e=ee(e),(r instanceof L||r instanceof Ce)&&(e instanceof L||e instanceof Ce)&&r.firestore===e.firestore&&r.path===e.path&&r.converter===e.converter}function ml(r,e){return r=ee(r),e=ee(e),r instanceof oe&&e instanceof oe&&r.firestore===e.firestore&&lr(r._query,e._query)&&r.converter===e.converter}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Fa="AsyncQueue";class Ma{constructor(e=Promise.resolve()){this.Yu=[],this.ec=!1,this.tc=[],this.nc=null,this.rc=!1,this.sc=!1,this.oc=[],this.M_=new Ui(this,"async_queue_retry"),this._c=()=>{const n=Or();n&&p(Fa,"Visibility state changed to "+n.visibilityState),this.M_.w_()},this.ac=e;const t=Or();t&&typeof t.addEventListener=="function"&&t.addEventListener("visibilitychange",this._c)}get isShuttingDown(){return this.ec}enqueueAndForget(e){this.enqueue(e)}enqueueAndForgetEvenWhileRestricted(e){this.uc(),this.cc(e)}enterRestrictedMode(e){if(!this.ec){this.ec=!0,this.sc=e||!1;const t=Or();t&&typeof t.removeEventListener=="function"&&t.removeEventListener("visibilitychange",this._c)}}enqueue(e){if(this.uc(),this.ec)return new Promise((()=>{}));const t=new ie;return this.cc((()=>this.ec&&this.sc?Promise.resolve():(e().then(t.resolve,t.reject),t.promise))).then((()=>t.promise))}enqueueRetryable(e){this.enqueueAndForget((()=>(this.Yu.push(e),this.lc())))}async lc(){if(this.Yu.length!==0){try{await this.Yu[0](),this.Yu.shift(),this.M_.reset()}catch(e){if(!ot(e))throw e;p(Fa,"Operation failed with retryable error: "+e)}this.Yu.length>0&&this.M_.p_((()=>this.lc()))}}cc(e){const t=this.ac.then((()=>(this.rc=!0,e().catch((n=>{throw this.nc=n,this.rc=!1,H("INTERNAL UNHANDLED ERROR: ",Oa(n)),n})).then((n=>(this.rc=!1,n))))));return this.ac=t,t}enqueueAfterDelay(e,t,n){this.uc(),this.oc.indexOf(e)>-1&&(t=0);const s=$i.createAndSchedule(this,e,t,n,(i=>this.hc(i)));return this.tc.push(s),s}uc(){this.nc&&A(47125,{Pc:Oa(this.nc)})}verifyOperationInProgress(){}async Tc(){let e;do e=this.ac,await e;while(e!==this.ac)}Ic(e){for(const t of this.tc)if(t.timerId===e)return!0;return!1}Ec(e){return this.Tc().then((()=>{this.tc.sort(((t,n)=>t.targetTimeMs-n.targetTimeMs));for(const t of this.tc)if(t.skipDelay(),e!=="all"&&t.timerId===e)break;return this.Tc()}))}Rc(e){this.oc.push(e)}hc(e){const t=this.tc.indexOf(e);this.tc.splice(t,1)}}function Oa(r){let e=r.message||"";return r.stack&&(e=r.stack.includes(r.message)?r.stack:r.message+`
`+r.stack),e}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Cm{constructor(){this._progressObserver={},this._taskCompletionResolver=new ie,this._lastProgress={taskState:"Running",totalBytes:0,totalDocuments:0,bytesLoaded:0,documentsLoaded:0}}onProgress(e,t,n){this._progressObserver={next:e,error:t,complete:n}}catch(e){return this._taskCompletionResolver.promise.catch(e)}then(e,t){return this._taskCompletionResolver.promise.then(e,t)}_completeWith(e){this._updateProgress(e),this._progressObserver.complete&&this._progressObserver.complete(),this._taskCompletionResolver.resolve(e)}_failWith(e){this._lastProgress.taskState="Error",this._progressObserver.next&&this._progressObserver.next(this._lastProgress),this._progressObserver.error&&this._progressObserver.error(e),this._taskCompletionResolver.reject(e)}_updateProgress(e){this._lastProgress=e,this._progressObserver.next&&this._progressObserver.next(e)}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const c_=-1;class q extends gr{constructor(e,t,n,s){super(e,t,n,s),this.type="firestore",this._queue=new Ma,this._persistenceKey=(s==null?void 0:s.name)||"[DEFAULT]"}async _terminate(){if(this._firestoreClient){const e=this._firestoreClient.terminate();this._queue=new Ma(e),this._firestoreClient=void 0,await e}}}function l_(r,e,t){t||(t=Xn);const n=ja(r,"firestore");if(n.isInitialized(t)){const s=n.getImmediate({identifier:t}),i=n.getOptions(t);if(or(i,e))return s;throw new g(m.FAILED_PRECONDITION,"initializeFirestore() has already been called with different options. To avoid this error, call initializeFirestore() with the same options as when it was originally called, or call getFirestore() to return the already initialized instance.")}if(e.cacheSizeBytes!==void 0&&e.localCache!==void 0)throw new g(m.INVALID_ARGUMENT,"cache and cacheSizeBytes cannot be specified at the same time as cacheSizeBytes willbe deprecated. Instead, specify the cache size in the cache object");if(e.cacheSizeBytes!==void 0&&e.cacheSizeBytes!==-1&&e.cacheSizeBytes<vc)throw new g(m.INVALID_ARGUMENT,"cacheSizeBytes must be at least 1048576");return e.host&&ci(e.host)&&Qa(e.host),n.initialize({options:e,instanceIdentifier:t})}function h_(r,e){const t=typeof r=="object"?r:Fl(),n=typeof r=="string"?r:e||Xn,s=ja(t,"firestore").getImmediate({identifier:n});if(!s._initialized){const i=Ml("firestore");i&&bm(s,...i)}return s}function j(r){if(r._terminated)throw new g(m.FAILED_PRECONDITION,"The client has already been terminated.");return r._firestoreClient||_l(r),r._firestoreClient}function _l(r){var n,s,i,o;const e=r._freezeSettings(),t=Pm(r._databaseId,((n=r._app)==null?void 0:n.options.appId)||"",r._persistenceKey,(s=r._app)==null?void 0:s.options.apiKey,e);r._componentsProvider||(i=e.localCache)!=null&&i._offlineComponentProvider&&((o=e.localCache)!=null&&o._onlineComponentProvider)&&(r._componentsProvider={_offline:e.localCache._offlineComponentProvider,_online:e.localCache._onlineComponentProvider}),r._firestoreClient=new hm(r._authCredentials,r._appCheckCredentials,r._queue,t,r._componentsProvider&&(function(u){const c=u==null?void 0:u._online.build();return{_offline:u==null?void 0:u._offline.build(c),_online:c}})(r._componentsProvider))}function d_(r,e){Te("enableIndexedDbPersistence() will be deprecated in the future, you can use `FirestoreSettings.cache` instead.");const t=r._freezeSettings();return gl(r,rt.provider,{build:n=>new no(n,t.cacheSizeBytes,e==null?void 0:e.forceOwnership)}),Promise.resolve()}async function f_(r){Te("enableMultiTabIndexedDbPersistence() will be deprecated in the future, you can use `FirestoreSettings.cache` instead.");const e=r._freezeSettings();gl(r,rt.provider,{build:t=>new il(t,e.cacheSizeBytes)})}function gl(r,e,t){if((r=D(r,q))._firestoreClient||r._terminated)throw new g(m.FAILED_PRECONDITION,"Firestore has already been started and persistence can no longer be enabled. You can only enable persistence before calling any other methods on a Firestore object.");if(r._componentsProvider||r._getSettings().localCache)throw new g(m.FAILED_PRECONDITION,"SDK cache is already specified.");r._componentsProvider={_online:e,_offline:t},_l(r)}function m_(r){if(r._initialized&&!r._terminated)throw new g(m.FAILED_PRECONDITION,"Persistence can only be cleared before a Firestore instance is initialized or after it is terminated.");const e=new ie;return r._queue.enqueueAndForgetEvenWhileRestricted((async()=>{try{await(async function(n){if(!be.v())return Promise.resolve();const s=n+Cc;await be.delete(s)})(Mi(r._databaseId,r._persistenceKey)),e.resolve()}catch(t){e.reject(t)}})),e.promise}function __(r){return(function(t){const n=new ie;return t.asyncQueue.enqueueAndForget((async()=>Hf(await so(t),n))),n.promise})(j(r=D(r,q)))}function g_(r){return dm(j(r=D(r,q)))}function p_(r){return fm(j(r=D(r,q)))}function y_(r){return Ol(r.app,"firestore",r._databaseId.database),r._delete()}function La(r,e){const t=j(r=D(r,q)),n=new Cm;return Em(t,r._databaseId,e,n),n}function xm(r,e){return wm(j(r=D(r,q)),e).then((t=>t?new oe(r,null,t.query):null))}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class pe{constructor(e){this._byteString=e}static fromBase64String(e){try{return new pe(W.fromBase64String(e))}catch(t){throw new g(m.INVALID_ARGUMENT,"Failed to construct data from Base64 string: "+t)}}static fromUint8Array(e){return new pe(W.fromUint8Array(e))}toBase64(){return this._byteString.toBase64()}toUint8Array(){return this._byteString.toUint8Array()}toString(){return"Bytes(base64: "+this.toBase64()+")"}isEqual(e){return this._byteString.isEqual(e._byteString)}toJSON(){return{type:pe._jsonSchemaVersion,bytes:this.toBase64()}}static fromJSON(e){if(Nt(e,pe._jsonSchema))return pe.fromBase64String(e.bytes)}}pe._jsonSchemaVersion="firestore/bytes/1.0",pe._jsonSchema={type:X("string",pe._jsonSchemaVersion),bytes:X("string")};/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Pn{constructor(...e){for(let t=0;t<e.length;++t)if(e[t].length===0)throw new g(m.INVALID_ARGUMENT,"Invalid field name at argument $(i + 1). Field names must not be empty.");this._internalPath=new $(e)}isEqual(e){return this._internalPath.isEqual(e._internalPath)}}function I_(){return new Pn(qs)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ft{constructor(e){this._methodName=e}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class xe{constructor(e,t){if(!isFinite(e)||e<-90||e>90)throw new g(m.INVALID_ARGUMENT,"Latitude must be a number between -90 and 90, but was: "+e);if(!isFinite(t)||t<-180||t>180)throw new g(m.INVALID_ARGUMENT,"Longitude must be a number between -180 and 180, but was: "+t);this._lat=e,this._long=t}get latitude(){return this._lat}get longitude(){return this._long}isEqual(e){return this._lat===e._lat&&this._long===e._long}_compareTo(e){return P(this._lat,e._lat)||P(this._long,e._long)}toJSON(){return{latitude:this._lat,longitude:this._long,type:xe._jsonSchemaVersion}}static fromJSON(e){if(Nt(e,xe._jsonSchema))return new xe(e.latitude,e.longitude)}}xe._jsonSchemaVersion="firestore/geoPoint/1.0",xe._jsonSchema={type:X("string",xe._jsonSchemaVersion),latitude:X("number"),longitude:X("number")};/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class we{constructor(e){this._values=(e||[]).map((t=>t))}toArray(){return this._values.map((e=>e))}isEqual(e){return(function(n,s){if(n.length!==s.length)return!1;for(let i=0;i<n.length;++i)if(n[i]!==s[i])return!1;return!0})(this._values,e._values)}toJSON(){return{type:we._jsonSchemaVersion,vectorValues:this._values}}static fromJSON(e){if(Nt(e,we._jsonSchema)){if(Array.isArray(e.vectorValues)&&e.vectorValues.every((t=>typeof t=="number")))return new we(e.vectorValues);throw new g(m.INVALID_ARGUMENT,"Expected 'vectorValues' field to be a number array")}}}we._jsonSchemaVersion="firestore/vectorValue/1.0",we._jsonSchema={type:X("string",we._jsonSchemaVersion),vectorValues:X("object")};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Dm=/^__.*__$/;class Nm{constructor(e,t,n){this.data=e,this.fieldMask=t,this.fieldTransforms=n}toMutation(e,t){return this.fieldMask!==null?new Ue(e,this.data,this.fieldMask,t,this.fieldTransforms):new Tn(e,this.data,t,this.fieldTransforms)}}class pl{constructor(e,t,n){this.data=e,this.fieldMask=t,this.fieldTransforms=n}toMutation(e,t){return new Ue(e,this.data,this.fieldMask,t,this.fieldTransforms)}}function yl(r){switch(r){case 0:case 2:case 1:return!0;case 3:case 4:return!1;default:throw A(40011,{dataSource:r})}}class Es{constructor(e,t,n,s,i,o){this.settings=e,this.databaseId=t,this.serializer=n,this.ignoreUndefinedProperties=s,i===void 0&&this.validatePath(),this.fieldTransforms=i||[],this.fieldMask=o||[]}get path(){return this.settings.path}get dataSource(){return this.settings.dataSource}contextWith(e){return new Es({...this.settings,...e},this.databaseId,this.serializer,this.ignoreUndefinedProperties,this.fieldTransforms,this.fieldMask)}childContextForField(e){var s;const t=(s=this.path)==null?void 0:s.child(e),n=this.contextWith({path:t,arrayElement:!1});return n.validatePathSegment(e),n}childContextForFieldPath(e){var s;const t=(s=this.path)==null?void 0:s.child(e),n=this.contextWith({path:t,arrayElement:!1});return n.validatePath(),n}childContextForArray(e){return this.contextWith({path:void 0,arrayElement:!0})}createError(e){return es(e,this.settings.methodName,this.settings.hasConverter||!1,this.path,this.settings.targetDoc)}contains(e){return this.fieldMask.find((t=>e.isPrefixOf(t)))!==void 0||this.fieldTransforms.find((t=>e.isPrefixOf(t.field)))!==void 0}validatePath(){if(this.path)for(let e=0;e<this.path.length;e++)this.validatePathSegment(this.path.get(e))}validatePathSegment(e){if(e.length===0)throw this.createError("Document fields must not be empty");if(yl(this.dataSource)&&Dm.test(e))throw this.createError('Document fields cannot begin and end with "__"')}}class km{constructor(e,t,n){this.databaseId=e,this.ignoreUndefinedProperties=t,this.serializer=n||kt(e)}createContext(e,t,n,s=!1){return new Es({dataSource:e,methodName:t,targetDoc:n,path:$.emptyPath(),arrayElement:!1,hasConverter:s},this.databaseId,this.serializer,this.ignoreUndefinedProperties)}}function Mt(r){const e=r._freezeSettings(),t=kt(r._databaseId);return new km(r._databaseId,!!e.ignoreUndefinedProperties,t)}function ws(r,e,t,n,s,i={}){const o=r.createContext(i.merge||i.mergeFields?2:0,e,t,s);ho("Data must be an object, but it was:",o,n);const a=El(n,o);let u,c;if(i.merge)u=new me(o.fieldMask),c=o.fieldTransforms;else if(i.mergeFields){const l=[];for(const h of i.mergeFields){const d=Oe(e,h,t);if(!o.contains(d))throw new g(m.INVALID_ARGUMENT,`Field '${d}' is specified in your field mask but missing from your input data.`);Al(l,d)||l.push(d)}u=new me(l),c=o.fieldTransforms.filter((h=>u.covers(h.field)))}else u=null,c=o.fieldTransforms;return new Nm(new se(a),u,c)}class pr extends Ft{_toFieldTransform(e){if(e.dataSource!==2)throw e.dataSource===1?e.createError(`${this._methodName}() can only appear at the top level of your update data`):e.createError(`${this._methodName}() cannot be used with set() unless you pass {merge:true}`);return e.fieldMask.push(e.path),null}isEqual(e){return e instanceof pr}}function Il(r,e,t){return new Es({dataSource:3,targetDoc:e.settings.targetDoc,methodName:r._methodName,arrayElement:t},e.databaseId,e.serializer,e.ignoreUndefinedProperties)}class io extends Ft{_toFieldTransform(e){return new dr(e.path,new cn)}isEqual(e){return e instanceof io}}class oo extends Ft{constructor(e,t){super(e),this.Ac=t}_toFieldTransform(e){const t=Il(this,e,!0),n=this.Ac.map((i=>Ot(i,t))),s=new Vt(n);return new dr(e.path,s)}isEqual(e){return e instanceof oo&&or(this.Ac,e.Ac)}}class ao extends Ft{constructor(e,t){super(e),this.Ac=t}_toFieldTransform(e){const t=Il(this,e,!0),n=this.Ac.map((i=>Ot(i,t))),s=new Pt(n);return new dr(e.path,s)}isEqual(e){return e instanceof ao&&or(this.Ac,e.Ac)}}class uo extends Ft{constructor(e,t){super(e),this.Vc=t}_toFieldTransform(e){const t=new ln(e.serializer,Ku(e.serializer,this.Vc));return new dr(e.path,t)}isEqual(e){return e instanceof uo&&this.Vc===e.Vc}}function co(r,e,t,n){const s=r.createContext(1,e,t);ho("Data must be an object, but it was:",s,n);const i=[],o=se.empty();at(n,((u,c)=>{const l=fo(e,u,t);c=ee(c);const h=s.childContextForFieldPath(l);if(c instanceof pr)i.push(l);else{const d=Ot(c,h);d!=null&&(i.push(l),o.set(l,d))}}));const a=new me(i);return new pl(o,a,s.fieldTransforms)}function lo(r,e,t,n,s,i){const o=r.createContext(1,e,t),a=[Oe(e,n,t)],u=[s];if(i.length%2!=0)throw new g(m.INVALID_ARGUMENT,`Function ${e}() needs to be called with an even number of arguments that alternate between field names and values.`);for(let d=0;d<i.length;d+=2)a.push(Oe(e,i[d])),u.push(i[d+1]);const c=[],l=se.empty();for(let d=a.length-1;d>=0;--d)if(!Al(c,a[d])){const _=a[d];let y=u[d];y=ee(y);const I=o.childContextForFieldPath(_);if(y instanceof pr)c.push(_);else{const T=Ot(y,I);T!=null&&(c.push(_),l.set(_,T))}}const h=new me(c);return new pl(l,h,o.fieldTransforms)}function Tl(r,e,t,n=!1){return Ot(t,r.createContext(n?4:3,e))}function Ot(r,e){if(wl(r=ee(r)))return ho("Unsupported field value:",e,r),El(r,e);if(r instanceof Ft)return(function(n,s){if(!yl(s.dataSource))throw s.createError(`${n._methodName}() can only be used with update() and set()`);if(!s.path)throw s.createError(`${n._methodName}() is not currently supported inside arrays`);const i=n._toFieldTransform(s);i&&s.fieldTransforms.push(i)})(r,e),null;if(r===void 0&&e.ignoreUndefinedProperties)return null;if(e.path&&e.fieldMask.push(e.path),r instanceof Array){if(e.settings.arrayElement&&e.dataSource!==4)throw e.createError("Nested arrays are not supported");return(function(n,s){const i=[];let o=0;for(const a of n){let u=Ot(a,s.childContextForArray(o));u==null&&(u={nullValue:"NULL_VALUE"}),i.push(u),o++}return{arrayValue:{values:i}}})(r,e)}return(function(n,s){if((n=ee(n))===null)return{nullValue:"NULL_VALUE"};if(typeof n=="number")return Ku(s.serializer,n);if(typeof n=="boolean")return{booleanValue:n};if(typeof n=="string")return{stringValue:n};if(n instanceof Date){const i=F.fromDate(n);return{timestampValue:hn(s.serializer,i)}}if(n instanceof F){const i=new F(n.seconds,1e3*Math.floor(n.nanoseconds/1e3));return{timestampValue:hn(s.serializer,i)}}if(n instanceof xe)return{geoPointValue:{latitude:n.latitude,longitude:n.longitude}};if(n instanceof pe)return{bytesValue:sc(s.serializer,n._byteString)};if(n instanceof L){const i=s.databaseId,o=n.firestore._databaseId;if(!o.isEqual(i))throw s.createError(`Document reference is for database ${o.projectId}/${o.database} but should be for database ${i.projectId}/${i.database}`);return{referenceValue:Ci(n.firestore._databaseId||s.databaseId,n._key.path)}}if(n instanceof we)return(function(o,a){const u=o instanceof we?o.toArray():o;return{mapValue:{fields:{[Ii]:{stringValue:Ti},[on]:{arrayValue:{values:u.map((l=>{if(typeof l!="number")throw a.createError("VectorValues must only contain numeric values.");return vi(a.serializer,l)}))}}}}}})(n,s);if(_c(n))return n._toProto(s.serializer);throw s.createError(`Unsupported field value: ${ts(n)}`)})(r,e)}function El(r,e){const t={};return yu(r)?e.path&&e.path.length>0&&e.fieldMask.push(e.path):at(r,((n,s)=>{const i=Ot(s,e.childContextForField(n));i!=null&&(t[n]=i)})),{mapValue:{fields:t}}}function wl(r){return!(typeof r!="object"||r===null||r instanceof Array||r instanceof Date||r instanceof F||r instanceof xe||r instanceof pe||r instanceof L||r instanceof Ft||r instanceof we||_c(r))}function ho(r,e,t){if(!wl(t)||!Za(t)){const n=ts(t);throw n==="an object"?e.createError(r+" a custom object"):e.createError(r+" "+n)}}function Oe(r,e,t){if((e=ee(e))instanceof Pn)return e._internalPath;if(typeof e=="string")return fo(r,e);throw es("Field path arguments must be of type string or ",r,!1,void 0,t)}const Fm=new RegExp("[~\\*/\\[\\]]");function fo(r,e,t){if(e.search(Fm)>=0)throw es(`Invalid field path (${e}). Paths must not contain '~', '*', '/', '[', or ']'`,r,!1,void 0,t);try{return new Pn(...e.split("."))._internalPath}catch{throw es(`Invalid field path (${e}). Paths must not be empty, begin with '.', end with '.', or contain '..'`,r,!1,void 0,t)}}function es(r,e,t,n,s){const i=n&&!n.isEmpty(),o=s!==void 0;let a=`Function ${e}() called with invalid data`;t&&(a+=" (via `toFirestore()`)"),a+=". ";let u="";return(i||o)&&(u+=" (found",i&&(u+=` in field ${n}`),o&&(u+=` in document ${s}`),u+=")"),new g(m.INVALID_ARGUMENT,a+r+u)}function Al(r,e){return r.some((t=>t.isEqual(e)))}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class vl{convertValue(e,t="none"){switch(Ze(e)){case 0:return null;case 1:return e.booleanValue;case 2:return G(e.integerValue||e.doubleValue);case 3:return this.convertTimestamp(e.timestampValue);case 4:return this.convertServerTimestamp(e,t);case 5:return e.stringValue;case 6:return this.convertBytes(Me(e.bytesValue));case 7:return this.convertReference(e.referenceValue);case 8:return this.convertGeoPoint(e.geoPointValue);case 9:return this.convertArray(e.arrayValue,t);case 11:return this.convertObject(e.mapValue,t);case 10:return this.convertVectorValue(e.mapValue);default:throw A(62114,{value:e})}}convertObject(e,t){return this.convertObjectMap(e.fields,t)}convertObjectMap(e,t="none"){const n={};return at(e,((s,i)=>{n[s]=this.convertValue(i,t)})),n}convertVectorValue(e){var n,s,i;const t=(i=(s=(n=e.fields)==null?void 0:n[on].arrayValue)==null?void 0:s.values)==null?void 0:i.map((o=>G(o.doubleValue)));return new we(t)}convertGeoPoint(e){return new xe(G(e.latitude),G(e.longitude))}convertArray(e,t){return(e.values||[]).map((n=>this.convertValue(n,t)))}convertServerTimestamp(e,t){switch(t){case"previous":const n=as(e);return n==null?null:this.convertValue(n,t);case"estimate":return this.convertTimestamp(Yn(e));default:return null}}convertTimestamp(e){const t=Fe(e);return new F(t.seconds,t.nanos)}convertDocumentKey(e,t){const n=x.fromString(e);v(mc(n),9688,{name:e});const s=new At(n.get(1),n.get(3)),i=new E(n.popFirst(5));return s.isEqual(t)||H(`Document ${i} contains a document reference within a different database (${s.projectId}/${s.database}) which is not supported. It will be treated as a reference in the current database (${t.projectId}/${t.database}) instead.`),i}}/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class lt extends vl{constructor(e){super(),this.firestore=e}convertBytes(e){return new pe(e)}convertReference(e){const t=this.convertDocumentKey(e,this.firestore._databaseId);return new L(this.firestore,null,t)}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function T_(){return new pr("deleteField")}function E_(){return new io("serverTimestamp")}function w_(...r){return new oo("arrayUnion",r)}function A_(...r){return new ao("arrayRemove",r)}function v_(r){return new uo("increment",r)}function R_(r){return new we(r)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function V_(r){var n;const e=j(D(r.firestore,q)),t=(n=e._onlineComponents)==null?void 0:n.datastore.serializer;return t===void 0?null:ds(t,he(r._query)).ft}function P_(r,e){var i;const t=pu(e,((o,a)=>new Xu(a,o.aggregateType,o._internalFieldPath))),n=j(D(r.firestore,q)),s=(i=n._onlineComponents)==null?void 0:i.datastore.serializer;return s===void 0?null:lc(s,Mu(r._query),t,!0).request}const qa="@firebase/firestore",Ua="4.11.0";/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Jt(r){return(function(t,n){if(typeof t!="object"||t===null)return!1;const s=t;for(const i of n)if(i in s&&typeof s[i]=="function")return!0;return!1})(r,["next","error","complete"])}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class sr{constructor(e="count",t){this._internalFieldPath=t,this.type="AggregateField",this.aggregateType=e}}class Mm{constructor(e,t,n){this._userDataWriter=t,this._data=n,this.type="AggregateQuerySnapshot",this.query=e}data(){return this._userDataWriter.convertObjectMap(this._data)}_fieldsProto(){return new se({mapValue:{fields:this._data}}).clone().value.mapValue.fields}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ir{constructor(e,t,n,s,i){this._firestore=e,this._userDataWriter=t,this._key=n,this._document=s,this._converter=i}get id(){return this._key.path.lastSegment()}get ref(){return new L(this._firestore,this._converter,this._key)}exists(){return this._document!==null}data(){if(this._document){if(this._converter){const e=new Om(this._firestore,this._userDataWriter,this._key,this._document,null);return this._converter.fromFirestore(e)}return this._userDataWriter.convertValue(this._document.data.value)}}_fieldsProto(){var e;return((e=this._document)==null?void 0:e.data.clone().value.mapValue.fields)??void 0}get(e){if(this._document){const t=this._document.data.field(Oe("DocumentSnapshot.get",e));if(t!==null)return this._userDataWriter.convertValue(t)}}}class Om extends ir{data(){return super.data()}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Rl(r){if(r.limitType==="L"&&r.explicitOrderBy.length===0)throw new g(m.UNIMPLEMENTED,"limitToLast() queries require specifying at least one orderBy() clause")}class mo{}class yr extends mo{}function b_(r,e,...t){let n=[];e instanceof mo&&n.push(e),n=n.concat(t),(function(i){const o=i.filter((u=>u instanceof bn)).length,a=i.filter((u=>u instanceof Ir)).length;if(o>1||o>0&&a>0)throw new g(m.INVALID_ARGUMENT,"InvalidQuery. When using composite filters, you cannot use more than one filter at the top level. Consider nesting the multiple filters within an `and(...)` statement. For example: change `query(query, where(...), or(...))` to `query(query, and(where(...), or(...)))`.")})(n);for(const s of n)r=s._apply(r);return r}class Ir extends yr{constructor(e,t,n){super(),this._field=e,this._op=t,this._value=n,this.type="where"}static _create(e,t,n){return new Ir(e,t,n)}_apply(e){const t=this._parse(e);return Pl(e._query,t),new oe(e.firestore,e.converter,Js(e._query,t))}_parse(e){const t=Mt(e.firestore);return(function(i,o,a,u,c,l,h){let d;if(c.isKeyField()){if(l==="array-contains"||l==="array-contains-any")throw new g(m.INVALID_ARGUMENT,`Invalid Query. You can't perform '${l}' queries on documentId().`);if(l==="in"||l==="not-in"){za(h,l);const y=[];for(const I of h)y.push(Ba(u,i,I));d={arrayValue:{values:y}}}else d=Ba(u,i,h)}else l!=="in"&&l!=="not-in"&&l!=="array-contains-any"||za(h,l),d=Tl(a,o,h,l==="in"||l==="not-in");return N.create(c,l,d)})(e._query,"where",t,e.firestore._databaseId,this._field,this._op,this._value)}}function S_(r,e,t){const n=e,s=Oe("where",r);return Ir._create(s,n,t)}class bn extends mo{constructor(e,t){super(),this.type=e,this._queryConstraints=t}static _create(e,t){return new bn(e,t)}_parse(e){const t=this._queryConstraints.map((n=>n._parse(e))).filter((n=>n.getFilters().length>0));return t.length===1?t[0]:M.create(t,this._getOperator())}_apply(e){const t=this._parse(e);return t.getFilters().length===0?e:((function(s,i){let o=s;const a=i.getFlattenedFilters();for(const u of a)Pl(o,u),o=Js(o,u)})(e._query,t),new oe(e.firestore,e.converter,Js(e._query,t)))}_getQueryConstraints(){return this._queryConstraints}_getOperator(){return this.type==="and"?"and":"or"}}function C_(...r){return r.forEach((e=>bl("or",e))),bn._create("or",r)}function x_(...r){return r.forEach((e=>bl("and",e))),bn._create("and",r)}class _o extends yr{constructor(e,t){super(),this._field=e,this._direction=t,this.type="orderBy"}static _create(e,t){return new _o(e,t)}_apply(e){const t=(function(s,i,o){if(s.startAt!==null)throw new g(m.INVALID_ARGUMENT,"Invalid query. You must not call startAt() or startAfter() before calling orderBy().");if(s.endAt!==null)throw new g(m.INVALID_ARGUMENT,"Invalid query. You must not call endAt() or endBefore() before calling orderBy().");return new tr(i,o)})(e._query,this._field,this._direction);return new oe(e.firestore,e.converter,ed(e._query,t))}}function D_(r,e="asc"){const t=e,n=Oe("orderBy",r);return _o._create(n,t)}class As extends yr{constructor(e,t,n){super(),this.type=e,this._limit=t,this._limitType=n}static _create(e,t,n){return new As(e,t,n)}_apply(e){return new oe(e.firestore,e.converter,Kr(e._query,this._limit,this._limitType))}}function N_(r){return eu("limit",r),As._create("limit",r,"F")}function k_(r){return eu("limitToLast",r),As._create("limitToLast",r,"L")}class vs extends yr{constructor(e,t,n){super(),this.type=e,this._docOrFields=t,this._inclusive=n}static _create(e,t,n){return new vs(e,t,n)}_apply(e){const t=Vl(e,this.type,this._docOrFields,this._inclusive);return new oe(e.firestore,e.converter,td(e._query,t))}}function F_(...r){return vs._create("startAt",r,!0)}function M_(...r){return vs._create("startAfter",r,!1)}class Rs extends yr{constructor(e,t,n){super(),this.type=e,this._docOrFields=t,this._inclusive=n}static _create(e,t,n){return new Rs(e,t,n)}_apply(e){const t=Vl(e,this.type,this._docOrFields,this._inclusive);return new oe(e.firestore,e.converter,nd(e._query,t))}}function O_(...r){return Rs._create("endBefore",r,!1)}function L_(...r){return Rs._create("endAt",r,!0)}function Vl(r,e,t,n){if(t[0]=ee(t[0]),t[0]instanceof ir)return(function(i,o,a,u,c){if(!u)throw new g(m.NOT_FOUND,`Can't use a DocumentSnapshot that doesn't exist for ${a}().`);const l=[];for(const h of Wt(i))if(h.field.isKeyField())l.push(vt(o,u.key));else{const d=u.data.field(h.field);if(os(d))throw new g(m.INVALID_ARGUMENT,'Invalid query. You are trying to start or end a query using a document for which the field "'+h.field+'" is an uncommitted server timestamp. (Since the value of this field is unknown, you cannot start/end a query with it.)');if(d===null){const _=h.field.canonicalString();throw new g(m.INVALID_ARGUMENT,`Invalid query. You are trying to start or end a query using a document for which the field '${_}' (used as the orderBy) does not exist.`)}l.push(d)}return new tt(l,c)})(r._query,r.firestore._databaseId,e,t[0]._document,n);{const s=Mt(r.firestore);return(function(o,a,u,c,l,h){const d=o.explicitOrderBy;if(l.length>d.length)throw new g(m.INVALID_ARGUMENT,`Too many arguments provided to ${c}(). The number of arguments must be less than or equal to the number of orderBy() clauses`);const _=[];for(let y=0;y<l.length;y++){const I=l[y];if(d[y].field.isKeyField()){if(typeof I!="string")throw new g(m.INVALID_ARGUMENT,`Invalid query. Expected a string for document ID in ${c}(), but got a ${typeof I}`);if(!wi(o)&&I.indexOf("/")!==-1)throw new g(m.INVALID_ARGUMENT,`Invalid query. When querying a collection and ordering by documentId(), the value passed to ${c}() must be a plain document ID, but '${I}' contains a slash.`);const T=o.path.child(x.fromString(I));if(!E.isDocumentKey(T))throw new g(m.INVALID_ARGUMENT,`Invalid query. When querying a collection group and ordering by documentId(), the value passed to ${c}() must result in a valid document path, but '${T}' is not because it contains an odd number of segments.`);const V=new E(T);_.push(vt(a,V))}else{const T=Tl(u,c,I);_.push(T)}}return new tt(_,h)})(r._query,r.firestore._databaseId,s,e,t,n)}}function Ba(r,e,t){if(typeof(t=ee(t))=="string"){if(t==="")throw new g(m.INVALID_ARGUMENT,"Invalid query. When querying with documentId(), you must provide a valid document ID, but it was an empty string.");if(!wi(e)&&t.indexOf("/")!==-1)throw new g(m.INVALID_ARGUMENT,`Invalid query. When querying a collection by documentId(), you must provide a plain document ID, but '${t}' contains a '/' character.`);const n=e.path.child(x.fromString(t));if(!E.isDocumentKey(n))throw new g(m.INVALID_ARGUMENT,`Invalid query. When querying a collection group by documentId(), the value provided must result in a valid document path, but '${n}' is not because it has an odd number of segments (${n.length}).`);return vt(r,new E(n))}if(t instanceof L)return vt(r,t._key);throw new g(m.INVALID_ARGUMENT,`Invalid query. When querying with documentId(), you must provide a valid string or a DocumentReference, but it was: ${ts(t)}.`)}function za(r,e){if(!Array.isArray(r)||r.length===0)throw new g(m.INVALID_ARGUMENT,`Invalid Query. A non-empty array is required for '${e.toString()}' filters.`)}function Pl(r,e){const t=(function(s,i){for(const o of s)for(const a of o.getFlattenedFilters())if(i.indexOf(a.op)>=0)return a.op;return null})(r.filters,(function(s){switch(s){case"!=":return["!=","not-in"];case"array-contains-any":case"in":return["not-in"];case"not-in":return["array-contains-any","in","not-in","!="];default:return[]}})(e.op));if(t!==null)throw t===e.op?new g(m.INVALID_ARGUMENT,`Invalid query. You cannot use more than one '${e.op.toString()}' filter.`):new g(m.INVALID_ARGUMENT,`Invalid query. You cannot use '${e.op.toString()}' filters with '${t.toString()}' filters.`)}function bl(r,e){if(!(e instanceof Ir||e instanceof bn))throw new g(m.INVALID_ARGUMENT,`Function ${r}() requires AppliableConstraints created with a call to 'where(...)', 'or(...)', or 'and(...)'.`)}function Vs(r,e,t){let n;return n=r?t&&(t.merge||t.mergeFields)?r.toFirestore(e,t):r.toFirestore(e):e,n}class go extends vl{constructor(e){super(),this.firestore=e}convertBytes(e){return new pe(e)}convertReference(e){const t=this.convertDocumentKey(e,this.firestore._databaseId);return new L(this.firestore,null,t)}}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function q_(r){return new sr("sum",Oe("sum",r))}function U_(r){return new sr("avg",Oe("average",r))}function Lm(){return new sr("count")}function B_(r,e){var t,n;return r instanceof sr&&e instanceof sr&&r.aggregateType===e.aggregateType&&((t=r._internalFieldPath)==null?void 0:t.canonicalString())===((n=e._internalFieldPath)==null?void 0:n.canonicalString())}function z_(r,e){return ml(r.query,e.query)&&or(r.data(),e.data())}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function G_(r){return qm(r,{count:Lm()})}function qm(r,e){const t=D(r.firestore,q),n=j(t),s=pu(e,((i,o)=>new Xu(o,i.aggregateType,i._internalFieldPath)));return pm(n,r._query,s).then((i=>(function(a,u,c){const l=new lt(a);return new Mm(u,l,c)})(t,r,i)))}class Um{constructor(e){this.kind="memory",this._onlineComponentProvider=rt.provider,this._offlineComponentProvider=e!=null&&e.garbageCollector?e.garbageCollector._offlineComponentProvider:{build:()=>new to(void 0)}}toJSON(){return{kind:this.kind}}}class Bm{constructor(e){let t;this.kind="persistent",e!=null&&e.tabManager?(e.tabManager._initialize(e),t=e.tabManager):(t=Qm(void 0),t._initialize(e)),this._onlineComponentProvider=t._onlineComponentProvider,this._offlineComponentProvider=t._offlineComponentProvider}toJSON(){return{kind:this.kind}}}class zm{constructor(){this.kind="memoryEager",this._offlineComponentProvider=gn.provider}toJSON(){return{kind:this.kind}}}class Gm{constructor(e){this.kind="memoryLru",this._offlineComponentProvider={build:()=>new to(e)}}toJSON(){return{kind:this.kind}}}function $_(){return new zm}function K_(r){return new Gm(r==null?void 0:r.cacheSizeBytes)}function Q_(r){return new Um(r)}function j_(r){return new Bm(r)}class $m{constructor(e){this.forceOwnership=e,this.kind="persistentSingleTab"}toJSON(){return{kind:this.kind}}_initialize(e){this._onlineComponentProvider=rt.provider,this._offlineComponentProvider={build:t=>new no(t,e==null?void 0:e.cacheSizeBytes,this.forceOwnership)}}}class Km{constructor(){this.kind="PersistentMultipleTab"}toJSON(){return{kind:this.kind}}_initialize(e){this._onlineComponentProvider=rt.provider,this._offlineComponentProvider={build:t=>new il(t,e==null?void 0:e.cacheSizeBytes)}}}function Qm(r){return new $m(r==null?void 0:r.forceOwnership)}function W_(){return new Km}/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *//**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Sl="NOT SUPPORTED";class He{constructor(e,t){this.hasPendingWrites=e,this.fromCache=t}isEqual(e){return this.hasPendingWrites===e.hasPendingWrites&&this.fromCache===e.fromCache}}class ye extends ir{constructor(e,t,n,s,i,o){super(e,t,n,s,o),this._firestore=e,this._firestoreImpl=e,this.metadata=i}exists(){return super.exists()}data(e={}){if(this._document){if(this._converter){const t=new Lr(this._firestore,this._userDataWriter,this._key,this._document,this.metadata,null);return this._converter.fromFirestore(t,e)}return this._userDataWriter.convertValue(this._document.data.value,e.serverTimestamps)}}get(e,t={}){if(this._document){const n=this._document.data.field(Oe("DocumentSnapshot.get",e));if(n!==null)return this._userDataWriter.convertValue(n,t.serverTimestamps)}}toJSON(){if(this.metadata.hasPendingWrites)throw new g(m.FAILED_PRECONDITION,"DocumentSnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().");const e=this._document,t={};return t.type=ye._jsonSchemaVersion,t.bundle="",t.bundleSource="DocumentSnapshot",t.bundleName=this._key.toString(),!e||!e.isValidDocument()||!e.isFoundDocument()?t:(this._userDataWriter.convertObjectMap(e.data.value.mapValue.fields,"previous"),t.bundle=(this._firestore,this.ref.path,"NOT SUPPORTED"),t)}}function H_(r,e,t){if(Nt(e,ye._jsonSchema)){if(e.bundle===Sl)throw new g(m.INVALID_ARGUMENT,"The provided JSON object was created in a client environment, which is not supported.");const n=kt(r._databaseId),s=hl(e.bundle,n),i=s.t(),o=new Hi(s.getMetadata(),n);for(const l of i)o.o(l);const a=o.documents;if(a.length!==1)throw new g(m.INVALID_ARGUMENT,`Expected bundle data to contain 1 document, but it contains ${a.length} documents.`);const u=hs(n,a[0].document),c=new E(x.fromString(e.bundleName));return new ye(r,new go(r),c,u,new He(!1,!1),t||null)}}ye._jsonSchemaVersion="firestore/documentSnapshot/1.0",ye._jsonSchema={type:X("string",ye._jsonSchemaVersion),bundleSource:X("string","DocumentSnapshot"),bundleName:X("string"),bundle:X("string")};class Lr extends ye{data(e={}){return super.data(e)}}class Ie{constructor(e,t,n,s){this._firestore=e,this._userDataWriter=t,this._snapshot=s,this.metadata=new He(s.hasPendingWrites,s.fromCache),this.query=n}get docs(){const e=[];return this.forEach((t=>e.push(t))),e}get size(){return this._snapshot.docs.size}get empty(){return this.size===0}forEach(e,t){this._snapshot.docs.forEach((n=>{e.call(t,new Lr(this._firestore,this._userDataWriter,n.key,n,new He(this._snapshot.mutatedKeys.has(n.key),this._snapshot.fromCache),this.query.converter))}))}docChanges(e={}){const t=!!e.includeMetadataChanges;if(t&&this._snapshot.excludesMetadataChanges)throw new g(m.INVALID_ARGUMENT,"To include metadata changes with your document changes, you must also pass { includeMetadataChanges:true } to onSnapshot().");return this._cachedChanges&&this._cachedChangesIncludeMetadataChanges===t||(this._cachedChanges=(function(s,i){if(s._snapshot.oldDocs.isEmpty()){let o=0;return s._snapshot.docChanges.map((a=>{const u=new Lr(s._firestore,s._userDataWriter,a.doc.key,a.doc,new He(s._snapshot.mutatedKeys.has(a.doc.key),s._snapshot.fromCache),s.query.converter);return a.doc,{type:"added",doc:u,oldIndex:-1,newIndex:o++}}))}{let o=s._snapshot.oldDocs;return s._snapshot.docChanges.filter((a=>i||a.type!==3)).map((a=>{const u=new Lr(s._firestore,s._userDataWriter,a.doc.key,a.doc,new He(s._snapshot.mutatedKeys.has(a.doc.key),s._snapshot.fromCache),s.query.converter);let c=-1,l=-1;return a.type!==0&&(c=o.indexOf(a.doc.key),o=o.delete(a.doc.key)),a.type!==1&&(o=o.add(a.doc),l=o.indexOf(a.doc.key)),{type:jm(a.type),doc:u,oldIndex:c,newIndex:l}}))}})(this,t),this._cachedChangesIncludeMetadataChanges=t),this._cachedChanges}toJSON(){if(this.metadata.hasPendingWrites)throw new g(m.FAILED_PRECONDITION,"QuerySnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().");const e={};e.type=Ie._jsonSchemaVersion,e.bundleSource="QuerySnapshot",e.bundleName=hi.newId(),this._firestore._databaseId.database,this._firestore._databaseId.projectId;const t=[],n=[],s=[];return this.docs.forEach((i=>{i._document!==null&&(t.push(i._document),n.push(this._userDataWriter.convertObjectMap(i._document.data.value.mapValue.fields,"previous")),s.push(i.ref.path))})),e.bundle=(this._firestore,this.query._query,e.bundleName,"NOT SUPPORTED"),e}}function J_(r,e,t){if(Nt(e,Ie._jsonSchema)){if(e.bundle===Sl)throw new g(m.INVALID_ARGUMENT,"The provided JSON object was created in a client environment, which is not supported.");const n=kt(r._databaseId),s=hl(e.bundle,n),i=s.t(),o=new Hi(s.getMetadata(),n);for(const d of i)o.o(d);if(o.queries.length!==1)throw new g(m.INVALID_ARGUMENT,`Snapshot data expected 1 query but found ${o.queries.length} queries.`);const a=fs(o.queries[0].bundledQuery),u=o.documents;let c=new wt;u.map((d=>{const _=hs(n,d.document);c=c.add(_)}));const l=Dt.fromInitialDocuments(a,c,C(),!1,!1),h=new oe(r,t||null,a);return new Ie(r,new go(r),h,l)}}function jm(r){switch(r){case 0:return"added";case 2:case 3:return"modified";case 1:return"removed";default:return A(61501,{type:r})}}function Y_(r,e){return r instanceof ye&&e instanceof ye?r._firestore===e._firestore&&r._key.isEqual(e._key)&&(r._document===null?e._document===null:r._document.isEqual(e._document))&&r._converter===e._converter:r instanceof Ie&&e instanceof Ie&&r._firestore===e._firestore&&ml(r.query,e.query)&&r.metadata.isEqual(e.metadata)&&r._snapshot.isEqual(e._snapshot)}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */Ie._jsonSchemaVersion="firestore/querySnapshot/1.0",Ie._jsonSchema={type:X("string",Ie._jsonSchemaVersion),bundleSource:X("string","QuerySnapshot"),bundleName:X("string"),bundle:X("string")};const Wm={maxAttempts:5};/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Hm{constructor(e,t){this._firestore=e,this._commitHandler=t,this._mutations=[],this._committed=!1,this._dataReader=Mt(e)}set(e,t,n){this._verifyNotCommitted();const s=Je(e,this._firestore),i=Vs(s.converter,t,n),o=ws(this._dataReader,"WriteBatch.set",s._key,i,s.converter!==null,n);return this._mutations.push(o.toMutation(s._key,K.none())),this}update(e,t,n,...s){this._verifyNotCommitted();const i=Je(e,this._firestore);let o;return o=typeof(t=ee(t))=="string"||t instanceof Pn?lo(this._dataReader,"WriteBatch.update",i._key,t,n,s):co(this._dataReader,"WriteBatch.update",i._key,t),this._mutations.push(o.toMutation(i._key,K.exists(!0))),this}delete(e){this._verifyNotCommitted();const t=Je(e,this._firestore);return this._mutations=this._mutations.concat(new En(t._key,K.none())),this}commit(){return this._verifyNotCommitted(),this._committed=!0,this._mutations.length>0?this._commitHandler(this._mutations):Promise.resolve()}_verifyNotCommitted(){if(this._committed)throw new g(m.FAILED_PRECONDITION,"A write batch can no longer be used after commit() has been called.")}}function Je(r,e){if((r=ee(r)).firestore!==e)throw new g(m.INVALID_ARGUMENT,"Provided document reference is from a different Firestore instance.");return r}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Jm{constructor(e,t){this._firestore=e,this._transaction=t,this._dataReader=Mt(e)}get(e){const t=Je(e,this._firestore),n=new go(this._firestore);return this._transaction.lookup([t._key]).then((s=>{if(!s||s.length!==1)return A(24041);const i=s[0];if(i.isFoundDocument())return new ir(this._firestore,n,i.key,i,t.converter);if(i.isNoDocument())return new ir(this._firestore,n,t._key,null,t.converter);throw A(18433,{doc:i})}))}set(e,t,n){const s=Je(e,this._firestore),i=Vs(s.converter,t,n),o=ws(this._dataReader,"Transaction.set",s._key,i,s.converter!==null,n);return this._transaction.set(s._key,o),this}update(e,t,n,...s){const i=Je(e,this._firestore);let o;return o=typeof(t=ee(t))=="string"||t instanceof Pn?lo(this._dataReader,"Transaction.update",i._key,t,n,s):co(this._dataReader,"Transaction.update",i._key,t),this._transaction.update(i._key,o),this}delete(e){const t=Je(e,this._firestore);return this._transaction.delete(t._key),this}}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ym extends Jm{constructor(e,t){super(e,t),this._firestore=e}get(e){const t=Je(e,this._firestore),n=new lt(this._firestore);return super.get(e).then((s=>new ye(this._firestore,n,t._key,s._document,new He(!1,!1),t.converter)))}}function X_(r,e,t){r=D(r,q);const n={...Wm,...t};(function(o){if(o.maxAttempts<1)throw new g(m.INVALID_ARGUMENT,"Max attempts must be at least 1")})(n);const s=j(r);return Tm(s,(i=>e(new Ym(r,i))),n)}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Z_(r){r=D(r,L);const e=D(r.firestore,q),t=j(e);return cl(t,r._key).then((n=>po(e,r,n)))}function eg(r){r=D(r,L);const e=D(r.firestore,q),t=j(e),n=new lt(e);return _m(t,r._key).then((s=>new ye(e,n,r._key,s,new He(s!==null&&s.hasLocalMutations,!0),r.converter)))}function tg(r){r=D(r,L);const e=D(r.firestore,q),t=j(e);return cl(t,r._key,{source:"server"}).then((n=>po(e,r,n)))}function ng(r){r=D(r,oe);const e=D(r.firestore,q),t=j(e),n=new lt(e);return Rl(r._query),ll(t,r._query).then((s=>new Ie(e,n,r,s)))}function rg(r){r=D(r,oe);const e=D(r.firestore,q),t=j(e),n=new lt(e);return gm(t,r._query).then((s=>new Ie(e,n,r,s)))}function sg(r){r=D(r,oe);const e=D(r.firestore,q),t=j(e),n=new lt(e);return ll(t,r._query,{source:"server"}).then((s=>new Ie(e,n,r,s)))}function ig(r,e,t){r=D(r,L);const n=D(r.firestore,q),s=Vs(r.converter,e,t),i=Mt(n);return Tr(n,[ws(i,"setDoc",r._key,s,r.converter!==null,t).toMutation(r._key,K.none())])}function og(r,e,t,...n){r=D(r,L);const s=D(r.firestore,q),i=Mt(s);let o;return o=typeof(e=ee(e))=="string"||e instanceof Pn?lo(i,"updateDoc",r._key,e,t,n):co(i,"updateDoc",r._key,e),Tr(s,[o.toMutation(r._key,K.exists(!0))])}function ag(r){return Tr(D(r.firestore,q),[new En(r._key,K.none())])}function ug(r,e){const t=D(r.firestore,q),n=Sm(r),s=Vs(r.converter,e),i=Mt(r.firestore);return Tr(t,[ws(i,"addDoc",n._key,s,r.converter!==null,{}).toMutation(n._key,K.exists(!1))]).then((()=>n))}function Ga(r,...e){var c,l,h;r=ee(r);let t={includeMetadataChanges:!1,source:"default"},n=0;typeof e[n]!="object"||Jt(e[n])||(t=e[n++]);const s={includeMetadataChanges:t.includeMetadataChanges,source:t.source};if(Jt(e[n])){const d=e[n];e[n]=(c=d.next)==null?void 0:c.bind(d),e[n+1]=(l=d.error)==null?void 0:l.bind(d),e[n+2]=(h=d.complete)==null?void 0:h.bind(d)}let i,o,a;if(r instanceof L)o=D(r.firestore,q),a=In(r._key.path),i={next:d=>{e[n]&&e[n](po(o,r,d))},error:e[n+1],complete:e[n+2]};else{const d=D(r,oe);o=D(d.firestore,q),a=d._query;const _=new lt(o);i={next:y=>{e[n]&&e[n](new Ie(o,_,d,y))},error:e[n+1],complete:e[n+2]},Rl(r._query)}const u=j(o);return mm(u,a,s,i)}function cg(r,e,...t){const n=ee(r),s=(function(u){const c={bundle:"",bundleName:"",bundleSource:""},l=["bundle","bundleName","bundleSource"];for(const h of l){if(!(h in u)){c.error=`snapshotJson missing required field: ${h}`;break}const d=u[h];if(typeof d!="string"){c.error=`snapshotJson field '${h}' must be a string.`;break}if(d.length===0){c.error=`snapshotJson field '${h}' cannot be an empty string.`;break}h==="bundle"?c.bundle=d:h==="bundleName"?c.bundleName=d:h==="bundleSource"&&(c.bundleSource=d)}return c})(e);if(s.error)throw new g(m.INVALID_ARGUMENT,s.error);let i,o=0;if(typeof t[o]!="object"||Jt(t[o])||(i=t[o++]),s.bundleSource==="QuerySnapshot"){let a=null;if(typeof t[o]=="object"&&Jt(t[o])){const u=t[o++];a={next:u.next,error:u.error,complete:u.complete}}else a={next:t[o++],error:t[o++],complete:t[o++]};return(function(c,l,h,d,_){let y,I=!1;return La(c,l.bundle).then((()=>xm(c,l.bundleName))).then((V=>{V&&!I&&(_&&V.withConverter(_),y=Ga(V,h||{},d))})).catch((V=>(d.error&&d.error(V),()=>{}))),()=>{I||(I=!0,y&&y())}})(n,s,i,a,t[o])}if(s.bundleSource==="DocumentSnapshot"){let a=null;if(typeof t[o]=="object"&&Jt(t[o])){const u=t[o++];a={next:u.next,error:u.error,complete:u.complete}}else a={next:t[o++],error:t[o++],complete:t[o++]};return(function(c,l,h,d,_){let y,I=!1;return La(c,l.bundle).then((()=>{if(!I){const V=new L(c,_||null,E.fromPath(l.bundleName));y=Ga(V,h||{},d)}})).catch((V=>(d.error&&d.error(V),()=>{}))),()=>{I||(I=!0,y&&y())}})(n,s,i,a,t[o])}throw new g(m.INVALID_ARGUMENT,`unsupported bundle source: ${s.bundleSource}`)}function lg(r,e){r=D(r,q);const t=j(r),n=Jt(e)?e:{next:e};return Im(t,n)}function Tr(r,e){const t=j(r);return ym(t,e)}function po(r,e,t){const n=t.docs.get(e._key),s=new lt(r);return new ye(r,s,e._key,n,new He(t.hasPendingWrites,t.fromCache),e.converter)}function hg(r){return r=D(r,q),j(r),new Hm(r,(e=>Tr(r,e)))}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function dg(r,e){r=D(r,q);const t=j(r);if(!t._uninitializedComponentsProvider||t._uninitializedComponentsProvider._offline.kind==="memory")return Te("Cannot enable indexes when persistence is disabled"),Promise.resolve();const n=(function(i){const o=typeof i=="string"?(function(c){try{return JSON.parse(c)}catch(l){throw new g(m.INVALID_ARGUMENT,"Failed to parse JSON: "+(l==null?void 0:l.message))}})(i):i,a=[];if(Array.isArray(o.indexes))for(const u of o.indexes){const c=$a(u,"collectionGroup"),l=[];if(Array.isArray(u.fields))for(const h of u.fields){const d=$a(h,"fieldPath"),_=fo("setIndexConfiguration",d);h.arrayConfig==="CONTAINS"?l.push(new Tt(_,2)):h.order==="ASCENDING"?l.push(new Tt(_,0)):h.order==="DESCENDING"&&l.push(new Tt(_,1))}a.push(new Zt(Zt.UNKNOWN_ID,c,l,en.empty()))}return a})(e);return Am(t,n)}function $a(r,e){if(typeof r[e]!="string")throw new g(m.INVALID_ARGUMENT,"Missing string value for: "+e);return r[e]}/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Xm{constructor(e){this._firestore=e,this.type="PersistentCacheIndexManager"}}function fg(r){var s;r=D(r,q);const e=Ka.get(r);if(e)return e;if(((s=j(r)._uninitializedComponentsProvider)==null?void 0:s._offline.kind)!=="persistent")return null;const n=new Xm(r);return Ka.set(r,n),n}function mg(r){Cl(r,!0)}function _g(r){Cl(r,!1)}function gg(r){const e=j(r._firestore);Rm(e).then((t=>p("deleting all persistent cache indexes succeeded"))).catch((t=>Te("deleting all persistent cache indexes failed",t)))}function Cl(r,e){const t=j(r._firestore);vm(t,e).then((n=>p(`setting persistent cache index auto creation isEnabled=${e} succeeded`))).catch((n=>Te(`setting persistent cache index auto creation isEnabled=${e} failed`,n)))}const Ka=new WeakMap;/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class pg{constructor(){throw new Error("instances of this class should not be created")}static onExistenceFilterMismatch(e){return yo.instance.onExistenceFilterMismatch(e)}}class yo{constructor(){this.i=new Map}static get instance(){return br||(br=new yo,_d(br)),br}u(e){this.i.forEach((t=>t(e)))}onExistenceFilterMismatch(e){const t=Symbol(),n=this.i;return n.set(t,e),()=>n.delete(t)}}let br=null;(function(e,t=!0){Jl(Hl),jl(new Wl("firestore",((n,{instanceIdentifier:s,options:i})=>{const o=n.getProvider("app").getImmediate(),a=new q(new Zl(n.getProvider("auth-internal")),new nh(o,n.getProvider("app-check-internal")),zh(o,s),o);return i={useFetchStreams:t,...i},a._setSettings(i),a}),"PUBLIC").setMultipleInstances(!0)),To(qa,Ua,e),To(qa,Ua,"esm2020")})();export{vl as AbstractUserDataWriter,sr as AggregateField,Mm as AggregateQuerySnapshot,pe as Bytes,c_ as CACHE_SIZE_UNLIMITED,Ce as CollectionReference,L as DocumentReference,ye as DocumentSnapshot,Pn as FieldPath,Ft as FieldValue,q as Firestore,g as FirestoreError,xe as GeoPoint,Cm as LoadBundleTask,Xm as PersistentCacheIndexManager,oe as Query,bn as QueryCompositeFilterConstraint,yr as QueryConstraint,Lr as QueryDocumentSnapshot,Rs as QueryEndAtConstraint,Ir as QueryFieldFilterConstraint,As as QueryLimitConstraint,_o as QueryOrderByConstraint,Ie as QuerySnapshot,vs as QueryStartAtConstraint,He as SnapshotMetadata,F as Timestamp,Ym as Transaction,we as VectorValue,Hm as WriteBatch,hi as _AutoId,W as _ByteString,At as _DatabaseId,E as _DocumentKey,n_ as _EmptyAppCheckTokenProvider,Yl as _EmptyAuthCredentialsProvider,$ as _FieldPath,pg as _TestingHooks,D as _cast,t_ as _debugAssert,P_ as _internalAggregationQueryToProtoRunAggregationQueryRequest,V_ as _internalQueryToProtoQueryTarget,s_ as _isBase64Available,Te as _logWarn,ah as _validateIsNotUsedTogether,ug as addDoc,B_ as aggregateFieldEqual,z_ as aggregateQuerySnapshotEqual,x_ as and,A_ as arrayRemove,w_ as arrayUnion,U_ as average,m_ as clearIndexedDbPersistence,o_ as collection,a_ as collectionGroup,bm as connectFirestoreEmulator,Lm as count,gg as deleteAllPersistentCacheIndexes,ag as deleteDoc,T_ as deleteField,p_ as disableNetwork,_g as disablePersistentCacheIndexAutoCreation,Sm as doc,I_ as documentId,H_ as documentSnapshotFromJSON,d_ as enableIndexedDbPersistence,f_ as enableMultiTabIndexedDbPersistence,g_ as enableNetwork,mg as enablePersistentCacheIndexAutoCreation,L_ as endAt,O_ as endBefore,j as ensureFirestoreConfigured,Tr as executeWrite,qm as getAggregateFromServer,G_ as getCountFromServer,Z_ as getDoc,eg as getDocFromCache,tg as getDocFromServer,ng as getDocs,rg as getDocsFromCache,sg as getDocsFromServer,h_ as getFirestore,fg as getPersistentCacheIndexManager,v_ as increment,l_ as initializeFirestore,N_ as limit,k_ as limitToLast,La as loadBundle,$_ as memoryEagerGarbageCollector,Q_ as memoryLocalCache,K_ as memoryLruGarbageCollector,xm as namedQuery,Ga as onSnapshot,cg as onSnapshotResume,lg as onSnapshotsInSync,C_ as or,D_ as orderBy,j_ as persistentLocalCache,W_ as persistentMultipleTabManager,Qm as persistentSingleTabManager,b_ as query,ml as queryEqual,J_ as querySnapshotFromJSON,u_ as refEqual,X_ as runTransaction,E_ as serverTimestamp,ig as setDoc,dg as setIndexConfiguration,e_ as setLogLevel,Y_ as snapshotEqual,M_ as startAfter,F_ as startAt,q_ as sum,y_ as terminate,og as updateDoc,R_ as vector,__ as waitForPendingWrites,S_ as where,hg as writeBatch};
