import{g as y,_ as S,b as N,d as W,x as Y,y as x,z as L,j as O,A as k,L as q,t as E,C as _,v as C,B as D,F as H}from"./vendor-firebase-core-D5lXZ75A.js";/**
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
 */const I="analytics",V="firebase_id",J="origin",Q=60*1e3,X="https://firebase.googleapis.com/v1alpha/projects/-/apps/{app-id}/webConfig",A="https://www.googletagmanager.com/gtag/js";/**
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
 */const d=new q("@firebase/analytics");/**
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
 */const Z={"already-exists":"A Firebase Analytics instance with the appId {$id}  already exists. Only one Firebase Analytics instance can be created for each appId.","already-initialized":"initializeAnalytics() cannot be called again with different options than those it was initially called with. It can be called again with the same options to return the existing instance, or getAnalytics() can be used to get a reference to the already-initialized instance.","already-initialized-settings":"Firebase Analytics has already been initialized.settings() must be called before initializing any Analytics instanceor it will have no effect.","interop-component-reg-failed":"Firebase Analytics Interop Component failed to instantiate: {$reason}","invalid-analytics-context":"Firebase Analytics is not supported in this environment. Wrap initialization of analytics in analytics.isSupported() to prevent initialization in unsupported environments. Details: {$errorInfo}","indexeddb-unavailable":"IndexedDB unavailable or restricted in this environment. Wrap initialization of analytics in analytics.isSupported() to prevent initialization in unsupported environments. Details: {$errorInfo}","fetch-throttle":"The config fetch request timed out while in an exponential backoff state. Unix timestamp in milliseconds when fetch request throttling ends: {$throttleEndTimeMillis}.","config-fetch-failed":"Dynamic config fetch failed: [{$httpStatus}] {$responseMessage}","no-api-key":'The "apiKey" field is empty in the local Firebase config. Firebase Analytics requires this field tocontain a valid API key.',"no-app-id":'The "appId" field is empty in the local Firebase config. Firebase Analytics requires this field tocontain a valid app ID.',"no-client-id":'The "client_id" field is empty.',"invalid-gtag-resource":"Trusted Types detected an invalid gtag resource: {$gtagURL}."},f=new Y("analytics","Analytics",Z);/**
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
 */function ee(e){if(!e.startsWith(A)){const t=f.create("invalid-gtag-resource",{gtagURL:e});return d.warn(t.message),""}return e}function z(e){return Promise.all(e.map(t=>t.catch(n=>n)))}function te(e,t){let n;return window.trustedTypes&&(n=window.trustedTypes.createPolicy(e,t)),n}function ne(e,t){const n=te("firebase-js-sdk-policy",{createScriptURL:ee}),a=document.createElement("script"),i=`${A}?l=${e}&id=${t}`;a.src=n?n==null?void 0:n.createScriptURL(i):i,a.async=!0,document.head.appendChild(a)}function ie(e){let t=[];return Array.isArray(window[e])?t=window[e]:window[e]=t,t}async function ae(e,t,n,a,i,s){const r=a[i];try{if(r)await t[r];else{const c=(await z(n)).find(l=>l.measurementId===i);c&&await t[c.appId]}}catch(o){d.error(o)}e("config",i,s)}async function se(e,t,n,a,i){try{let s=[];if(i&&i.send_to){let r=i.send_to;Array.isArray(r)||(r=[r]);const o=await z(n);for(const c of r){const l=o.find(m=>m.measurementId===c),h=l&&t[l.appId];if(h)s.push(h);else{s=[];break}}}s.length===0&&(s=Object.values(t)),await Promise.all(s),e("event",a,i||{})}catch(s){d.error(s)}}function re(e,t,n,a){async function i(s,...r){try{if(s==="event"){const[o,c]=r;await se(e,t,n,o,c)}else if(s==="config"){const[o,c]=r;await ae(e,t,n,a,o,c)}else if(s==="consent"){const[o,c]=r;e("consent",o,c)}else if(s==="get"){const[o,c,l]=r;e("get",o,c,l)}else if(s==="set"){const[o]=r;e("set",o)}else e(s,...r)}catch(o){d.error(o)}}return i}function oe(e,t,n,a,i){let s=function(...r){window[a].push(arguments)};return window[i]&&typeof window[i]=="function"&&(s=window[i]),window[i]=re(s,e,t,n),{gtagCore:s,wrappedGtag:window[i]}}function ce(e){const t=window.document.getElementsByTagName("script");for(const n of Object.values(t))if(n.src&&n.src.includes(A)&&n.src.includes(e))return n;return null}/**
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
 */const le=30,de=1e3;class fe{constructor(t={},n=de){this.throttleMetadata=t,this.intervalMillis=n}getThrottleMetadata(t){return this.throttleMetadata[t]}setThrottleMetadata(t,n){this.throttleMetadata[t]=n}deleteThrottleMetadata(t){delete this.throttleMetadata[t]}}const G=new fe;function ue(e){return new Headers({Accept:"application/json","x-goog-api-key":e})}async function pe(e){var r;const{appId:t,apiKey:n}=e,a={method:"GET",headers:ue(n)},i=X.replace("{app-id}",t),s=await fetch(i,a);if(s.status!==200&&s.status!==304){let o="";try{const c=await s.json();(r=c.error)!=null&&r.message&&(o=c.error.message)}catch{}throw f.create("config-fetch-failed",{httpStatus:s.status,responseMessage:o})}return s.json()}async function me(e,t=G,n){const{appId:a,apiKey:i,measurementId:s}=e.options;if(!a)throw f.create("no-app-id");if(!i){if(s)return{measurementId:s,appId:a};throw f.create("no-api-key")}const r=t.getThrottleMetadata(a)||{backoffCount:0,throttleEndTimeMillis:Date.now()},o=new ye;return setTimeout(async()=>{o.abort()},Q),U({appId:a,apiKey:i,measurementId:s},r,o,t)}async function U(e,{throttleEndTimeMillis:t,backoffCount:n},a,i=G){var o;const{appId:s,measurementId:r}=e;try{await he(a,t)}catch(c){if(r)return d.warn(`Timed out fetching this Firebase app's measurement ID from the server. Falling back to the measurement ID ${r} provided in the "measurementId" field in the local Firebase config. [${c==null?void 0:c.message}]`),{appId:s,measurementId:r};throw c}try{const c=await pe(e);return i.deleteThrottleMetadata(s),c}catch(c){const l=c;if(!ge(l)){if(i.deleteThrottleMetadata(s),r)return d.warn(`Failed to fetch this Firebase app's measurement ID from the server. Falling back to the measurement ID ${r} provided in the "measurementId" field in the local Firebase config. [${l==null?void 0:l.message}]`),{appId:s,measurementId:r};throw c}const h=Number((o=l==null?void 0:l.customData)==null?void 0:o.httpStatus)===503?D(n,i.intervalMillis,le):D(n,i.intervalMillis),m={throttleEndTimeMillis:Date.now()+h,backoffCount:n+1};return i.setThrottleMetadata(s,m),d.debug(`Calling attemptFetch again in ${h} millis`),U(e,m,a,i)}}function he(e,t){return new Promise((n,a)=>{const i=Math.max(t-Date.now(),0),s=setTimeout(n,i);e.addEventListener(()=>{clearTimeout(s),a(f.create("fetch-throttle",{throttleEndTimeMillis:t}))})})}function ge(e){if(!(e instanceof H)||!e.customData)return!1;const t=Number(e.customData.httpStatus);return t===429||t===500||t===503||t===504}class ye{constructor(){this.listeners=[]}addEventListener(t){this.listeners.push(t)}abort(){this.listeners.forEach(t=>t())}}/**
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
 */let b;async function we(e,t,n,a,i){if(i&&i.global){e("event",n,a);return}else{const s=await t,r={...a,send_to:s};e("event",n,r)}}async function Ie(e,t,n,a){if(a&&a.global)return e("set",{screen_name:n}),Promise.resolve();{const i=await t;e("config",i,{update:!0,screen_name:n})}}async function be(e,t,n,a){if(a&&a.global)return e("set",{user_id:n}),Promise.resolve();{const i=await t;e("config",i,{update:!0,user_id:n})}}async function ve(e,t,n,a){if(a&&a.global){const i={};for(const s of Object.keys(n))i[`user_properties.${s}`]=n[s];return e("set",i),Promise.resolve()}else{const i=await t;e("config",i,{update:!0,user_properties:n})}}async function Te(e,t){const n=await t;return new Promise((a,i)=>{e("get",n,"client_id",s=>{s||i(f.create("no-client-id")),a(s)})})}async function Ae(e,t){const n=await e;window[`ga-disable-${n}`]=!t}let v;function B(e){v=e}function j(e){b=e}/**
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
 */async function Ee(){if(O())try{await k()}catch(e){return d.warn(f.create("indexeddb-unavailable",{errorInfo:e==null?void 0:e.toString()}).message),!1}else return d.warn(f.create("indexeddb-unavailable",{errorInfo:"IndexedDB is not available in this environment."}).message),!1;return!0}async function _e(e,t,n,a,i,s,r){const o=me(e);o.then(g=>{n[g.measurementId]=g.appId,e.options.measurementId&&g.measurementId!==e.options.measurementId&&d.warn(`The measurement ID in the local Firebase config (${e.options.measurementId}) does not match the measurement ID fetched from the server (${g.measurementId}). To ensure analytics events are always sent to the correct Analytics property, update the measurement ID field in the local config or remove it from the local config.`)}).catch(g=>d.error(g)),t.push(o);const c=Ee().then(g=>{if(g)return a.getId()}),[l,h]=await Promise.all([o,c]);ce(s)||ne(s,l.measurementId),v&&(i("consent","default",v),B(void 0)),i("js",new Date);const m=(r==null?void 0:r.config)??{};return m[J]="firebase",m.update=!0,h!=null&&(m[V]=h),i("config",l.measurementId,m),b&&(i("set",b),j(void 0)),l.measurementId}/**
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
 */class Ce{constructor(t){this.app=t}_delete(){return delete u[this.app.options.appId],Promise.resolve()}}let u={},M=[];const P={};let w="dataLayer",K="gtag",R,p,T=!1;function xe(e){if(T)throw f.create("already-initialized");e.dataLayerName&&(w=e.dataLayerName),e.gtagName&&(K=e.gtagName)}function De(){const e=[];if(x()&&e.push("This is a browser extension environment."),L()||e.push("Cookies are not available."),e.length>0){const t=e.map((a,i)=>`(${i+1}) ${a}`).join(" "),n=f.create("invalid-analytics-context",{errorInfo:t});d.warn(n.message)}}function Me(e,t,n){De();const a=e.options.appId;if(!a)throw f.create("no-app-id");if(!e.options.apiKey)if(e.options.measurementId)d.warn(`The "apiKey" field is empty in the local Firebase config. This is needed to fetch the latest measurement ID for this Firebase app. Falling back to the measurement ID ${e.options.measurementId} provided in the "measurementId" field in the local Firebase config.`);else throw f.create("no-api-key");if(u[a]!=null)throw f.create("already-exists",{id:a});if(!T){ie(w);const{wrappedGtag:s,gtagCore:r}=oe(u,M,P,w,K);p=s,R=r,T=!0}return u[a]=_e(e,M,P,t,R,w,n),new Ce(e)}function Le(e=N()){e=y(e);const t=S(e,I);return t.isInitialized()?t.getImmediate():Pe(e)}function Pe(e,t={}){const n=S(e,I);if(n.isInitialized()){const i=n.getImmediate();if(W(t,n.getOptions()))return i;throw f.create("already-initialized")}return n.initialize({options:t})}async function Oe(){if(x()||!L()||!O())return!1;try{return await k()}catch{return!1}}function ke(e,t,n){e=y(e),Ie(p,u[e.app.options.appId],t,n).catch(a=>d.error(a))}async function ze(e){return e=y(e),Te(p,u[e.app.options.appId])}function Ge(e,t,n){e=y(e),be(p,u[e.app.options.appId],t,n).catch(a=>d.error(a))}function Re(e,t,n){e=y(e),ve(p,u[e.app.options.appId],t,n).catch(a=>d.error(a))}function Ue(e,t){e=y(e),Ae(u[e.app.options.appId],t).catch(n=>d.error(n))}function Be(e){p?p("set",e):j(e)}function Fe(e,t,n,a){e=y(e),we(p,u[e.app.options.appId],t,n,a).catch(i=>d.error(i))}function je(e){p?p("consent","update",e):B(e)}const F="@firebase/analytics",$="0.10.19";function $e(){E(new _(I,(t,{options:n})=>{const a=t.getProvider("app").getImmediate(),i=t.getProvider("installations-internal").getImmediate();return Me(a,i,n)},"PUBLIC")),E(new _("analytics-internal",e,"PRIVATE")),C(F,$),C(F,$,"esm2020");function e(t){try{const n=t.getProvider(I).getImmediate();return{logEvent:(a,i,s)=>Fe(n,a,i,s),setUserProperties:(a,i)=>Re(n,a,i)}}catch(n){throw f.create("interop-component-reg-failed",{reason:n})}}}$e();export{Le as getAnalytics,ze as getGoogleAnalyticsClientId,Pe as initializeAnalytics,Oe as isSupported,Fe as logEvent,Ue as setAnalyticsCollectionEnabled,je as setConsent,ke as setCurrentScreen,Be as setDefaultEventParameters,Ge as setUserId,Re as setUserProperties,xe as settings};
