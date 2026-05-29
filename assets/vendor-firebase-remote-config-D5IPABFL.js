import{g as d,_ as Q,d as Z,x as ee,b as te,j as z,A as se,a as S,F as G,t as ie,C as ae,v as L,L as ne,w as O,B as W,$ as I}from"./vendor-firebase-core-D5lXZ75A.js";const M="@firebase/remote-config",P="0.8.0";/**
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
 */class Y{constructor(){this.listeners=[]}addEventListener(e){this.listeners.push(e)}abort(){this.listeners.forEach(e=>e())}}/**
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
 */const q="remote-config",x=100,D=250,N=500;/**
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
 */const re={"already-initialized":"Remote Config already initialized","registration-window":"Undefined window object. This SDK only supports usage in a browser environment.","registration-project-id":"Undefined project identifier. Check Firebase app initialization.","registration-api-key":"Undefined API key. Check Firebase app initialization.","registration-app-id":"Undefined app identifier. Check Firebase app initialization.","storage-open":"Error thrown when opening storage. Original error: {$originalErrorMessage}.","storage-get":"Error thrown when reading from storage. Original error: {$originalErrorMessage}.","storage-set":"Error thrown when writing to storage. Original error: {$originalErrorMessage}.","storage-delete":"Error thrown when deleting from storage. Original error: {$originalErrorMessage}.","fetch-client-network":"Fetch client failed to connect to a network. Check Internet connection. Original error: {$originalErrorMessage}.","fetch-timeout":'The config fetch request timed out.  Configure timeout using "fetchTimeoutMillis" SDK setting.',"fetch-throttle":'The config fetch request timed out while in an exponential backoff state. Configure timeout using "fetchTimeoutMillis" SDK setting. Unix timestamp in milliseconds when fetch request throttling ends: {$throttleEndTimeMillis}.',"fetch-client-parse":"Fetch client could not parse response. Original error: {$originalErrorMessage}.","fetch-status":"Fetch server returned an HTTP error status. HTTP status: {$httpStatus}.","indexed-db-unavailable":"Indexed DB is not supported by current browser","custom-signal-max-allowed-signals":"Setting more than {$maxSignals} custom signals is not supported.","stream-error":"The stream was not able to connect to the backend: {$originalErrorMessage}.","realtime-unavailable":"The Realtime service is unavailable: {$originalErrorMessage}","update-message-invalid":"The stream invalidation message was unparsable: {$originalErrorMessage}","update-not-fetched":"Unable to fetch the latest config: {$originalErrorMessage}","analytics-unavailable":"Connection to Firebase Analytics failed: {$originalErrorMessage}"},g=new ee("remoteconfig","Remote Config",re);function oe(n,e){return n instanceof G&&n.code.indexOf(e)!==-1}/**
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
 */const ce=!1,le="",B=0,ge=["1","true","t","yes","y","on"];class R{constructor(e,t=le){this._source=e,this._value=t}asString(){return this._value}asBoolean(){return this._source==="static"?ce:ge.indexOf(this._value.toLowerCase())>=0}asNumber(){if(this._source==="static")return B;let e=Number(this._value);return isNaN(e)&&(e=B),e}getSource(){return this._source}}class he{constructor(e){this.storage=e._storage,this.logger=e._logger,this.analyticsProvider=e._analyticsProvider}async updateActiveExperiments(e){const t=await this.storage.getActiveExperiments()||new Set,s=this.createExperimentInfoMap(e);return this.addActiveExperiments(s),this.removeInactiveExperiments(t,s),this.storage.setActiveExperiments(new Set(s.keys()))}createExperimentInfoMap(e){const t=new Map;for(const s of e)t.set(s.experimentId,s);return t}addActiveExperiments(e){const t={};for(const[s,i]of e.entries())t[`firebase${s}`]=i.variantId;this.addExperimentToAnalytics(t)}removeInactiveExperiments(e,t){const s={};for(const i of e)t.has(i)||(s[`firebase${i}`]=null);this.addExperimentToAnalytics(s)}addExperimentToAnalytics(e){if(Object.keys(e).length!==0)try{const t=this.analyticsProvider.getImmediate({optional:!0});t?(t.setUserProperties(e),t.logEvent("set_firebase_experiment_state")):this.logger.warn("Analytics import failed. Verify if you have imported Firebase Analytics in your app code.")}catch(t){throw g.create("analytics-unavailable",{originalErrorMessage:t==null?void 0:t.message})}}}/**
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
 */function Ne(n=te(),e={}){var i,a;n=d(n);const t=Q(n,q);if(t.isInitialized()){const r=t.getOptions();if(Z(r,e))return t.getImmediate();throw g.create("already-initialized")}t.initialize({options:e});const s=t.getImmediate();return e.initialFetchResponse&&(s._initializePromise=Promise.all([s._storage.setLastSuccessfulFetchResponse(e.initialFetchResponse),s._storage.setActiveConfigEtag(((i=e.initialFetchResponse)==null?void 0:i.eTag)||""),s._storage.setActiveConfigTemplateVersion(e.initialFetchResponse.templateVersion||0),s._storageCache.setLastSuccessfulFetchTimestampMillis(Date.now()),s._storageCache.setLastFetchStatus("success"),s._storageCache.setActiveConfig(((a=e.initialFetchResponse)==null?void 0:a.config)||{})]).then(),s._isInitializationComplete=!0),s}async function ue(n){const e=d(n),[t,s]=await Promise.all([e._storage.getLastSuccessfulFetchResponse(),e._storage.getActiveConfigEtag()]);if(!t||!t.config||!t.eTag||!t.templateVersion||t.eTag===s)return!1;const i=new he(e),a=t.experiments?i.updateActiveExperiments(t.experiments):Promise.resolve();return await Promise.all([e._storageCache.setActiveConfig(t.config),e._storage.setActiveConfigEtag(t.eTag),e._storage.setActiveConfigTemplateVersion(t.templateVersion),a]),!0}function fe(n){const e=d(n);return e._initializePromise||(e._initializePromise=e._storageCache.loadFromStorage().then(()=>{e._isInitializationComplete=!0})),e._initializePromise}async function de(n){const e=d(n),t=new Y;setTimeout(async()=>{t.abort()},e.settings.fetchTimeoutMillis);const s=e._storageCache.getCustomSignals();s&&e._logger.debug(`Fetching config with custom signals: ${JSON.stringify(s)}`);try{await e._client.fetch({cacheMaxAgeMillis:e.settings.minimumFetchIntervalMillis,signal:t,customSignals:s}),await e._storageCache.setLastFetchStatus("success")}catch(i){const a=oe(i,"fetch-throttle")?"throttle":"failure";throw await e._storageCache.setLastFetchStatus(a),i}}function Be(n){const e=d(n);return me(e._storageCache.getActiveConfig(),e.defaultConfig).reduce((t,s)=>(t[s]=T(n,s),t),{})}function Ue(n,e){return T(d(n),e).asBoolean()}function He(n,e){return T(d(n),e).asNumber()}function Ve(n,e){return T(d(n),e).asString()}function T(n,e){const t=d(n);t._isInitializationComplete||t._logger.debug(`A value was requested for key "${e}" before SDK initialization completed. Await on ensureInitialized if the intent was to get a previously activated value.`);const s=t._storageCache.getActiveConfig();return s&&s[e]!==void 0?new R("remote",s[e]):t.defaultConfig&&t.defaultConfig[e]!==void 0?new R("default",String(t.defaultConfig[e])):(t._logger.debug(`Returning static value for key "${e}". Define a default or remote value if this is unintentional.`),new R("static"))}function $e(n,e){const t=d(n);switch(e){case"debug":t._logger.logLevel=S.DEBUG;break;case"silent":t._logger.logLevel=S.SILENT;break;default:t._logger.logLevel=S.ERROR}}function me(n={},e={}){return Object.keys({...n,...e})}async function Ke(n,e){const t=d(n);if(Object.keys(e).length!==0){for(const s in e){if(s.length>D){t._logger.error(`Custom signal key ${s} is too long, max allowed length is ${D}.`);return}const i=e[s];if(typeof i=="string"&&i.length>N){t._logger.error(`Value supplied for custom signal ${s} is too long, max allowed length is ${N}.`);return}}try{await t._storageCache.setCustomSignals(e)}catch(s){t._logger.error(`Error encountered while setting custom signals: ${s}`)}}}function je(n,e){const t=d(n);return t._realtimeHandler.addObserver(e),()=>{t._realtimeHandler.removeObserver(e)}}/**
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
 */class pe{constructor(e,t,s,i){this.client=e,this.storage=t,this.storageCache=s,this.logger=i}isCachedDataFresh(e,t){if(!t)return this.logger.debug("Config fetch cache check. Cache unpopulated."),!1;const s=Date.now()-t,i=s<=e;return this.logger.debug(`Config fetch cache check. Cache age millis: ${s}. Cache max age millis (minimumFetchIntervalMillis setting): ${e}. Is cache hit: ${i}.`),i}async fetch(e){const[t,s]=await Promise.all([this.storage.getLastSuccessfulFetchTimestampMillis(),this.storage.getLastSuccessfulFetchResponse()]);if(s&&this.isCachedDataFresh(e.cacheMaxAgeMillis,t))return s;e.eTag=s&&s.eTag;const i=await this.client.fetch(e),a=[this.storageCache.setLastSuccessfulFetchTimestampMillis(Date.now())];return i.status===200&&a.push(this.storage.setLastSuccessfulFetchResponse(i)),await Promise.all(a),i}}/**
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
 */function _e(n=navigator){return n.languages&&n.languages[0]||n.language}/**
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
 */class Ce{constructor(e,t,s,i,a,r){this.firebaseInstallations=e,this.sdkVersion=t,this.namespace=s,this.projectId=i,this.apiKey=a,this.appId=r}async fetch(e){const[t,s]=await Promise.all([this.firebaseInstallations.getId(),this.firebaseInstallations.getToken()]),a=`${window.FIREBASE_REMOTE_CONFIG_URL_BASE||"https://firebaseremoteconfig.googleapis.com"}/v1/projects/${this.projectId}/namespaces/${this.namespace}:fetch?key=${this.apiKey}`,r={"Content-Type":"application/json","Content-Encoding":"gzip","If-None-Match":e.eTag||"*"},o={sdk_version:this.sdkVersion,app_instance_id:t,app_instance_id_token:s,app_id:this.appId,language_code:_e(),custom_signals:e.customSignals},c={method:"POST",headers:r,body:JSON.stringify(o)},l=fetch(a,c),m=new Promise((f,_)=>{e.signal.addEventListener(()=>{const k=new Error("The operation was aborted.");k.name="AbortError",_(k)})});let h;try{await Promise.race([l,m]),h=await l}catch(f){let _="fetch-client-network";throw(f==null?void 0:f.name)==="AbortError"&&(_="fetch-timeout"),g.create(_,{originalErrorMessage:f==null?void 0:f.message})}let u=h.status;const b=h.headers.get("ETag")||void 0;let w,p,y,E;if(h.status===200){let f;try{f=await h.json()}catch(_){throw g.create("fetch-client-parse",{originalErrorMessage:_==null?void 0:_.message})}w=f.entries,p=f.state,y=f.templateVersion,E=f.experimentDescriptions}if(p==="INSTANCE_STATE_UNSPECIFIED"?u=500:p==="NO_CHANGE"?u=304:(p==="NO_TEMPLATE"||p==="EMPTY_CONFIG")&&(w={},E=[]),u!==304&&u!==200)throw g.create("fetch-status",{httpStatus:u});return{status:u,eTag:b,config:w,templateVersion:y,experiments:E}}}/**
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
 */function be(n,e){return new Promise((t,s)=>{const i=Math.max(e-Date.now(),0),a=setTimeout(t,i);n.addEventListener(()=>{clearTimeout(a),s(g.create("fetch-throttle",{throttleEndTimeMillis:e}))})})}function Ee(n){if(!(n instanceof G)||!n.customData)return!1;const e=Number(n.customData.httpStatus);return e===429||e===500||e===503||e===504}class we{constructor(e,t){this.client=e,this.storage=t}async fetch(e){const t=await this.storage.getThrottleMetadata()||{backoffCount:0,throttleEndTimeMillis:Date.now()};return this.attemptFetch(e,t)}async attemptFetch(e,{throttleEndTimeMillis:t,backoffCount:s}){await be(e.signal,t);try{const i=await this.client.fetch(e);return await this.storage.deleteThrottleMetadata(),i}catch(i){if(!Ee(i))throw i;const a={throttleEndTimeMillis:Date.now()+W(s),backoffCount:s+1};return await this.storage.setThrottleMetadata(a),this.attemptFetch(e,a)}}}/**
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
 */const ye=60*1e3,Se=720*60*1e3;class ve{get fetchTimeMillis(){return this._storageCache.getLastSuccessfulFetchTimestampMillis()||-1}get lastFetchStatus(){return this._storageCache.getLastFetchStatus()||"no-fetch-yet"}constructor(e,t,s,i,a,r,o){this.app=e,this._client=t,this._storageCache=s,this._storage=i,this._logger=a,this._realtimeHandler=r,this._analyticsProvider=o,this._isInitializationComplete=!1,this.settings={fetchTimeoutMillis:ye,minimumFetchIntervalMillis:Se},this.defaultConfig={}}}/**
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
 */function v(n,e){const t=n.target.error||void 0;return g.create(e,{originalErrorMessage:t&&(t==null?void 0:t.message)})}const C="app_namespace_store",Te="firebase_remote_config",Me=1;function Re(){return new Promise((n,e)=>{try{const t=indexedDB.open(Te,Me);t.onerror=s=>{e(v(s,"storage-open"))},t.onsuccess=s=>{n(s.target.result)},t.onupgradeneeded=s=>{const i=s.target.result;switch(s.oldVersion){case 0:i.createObjectStore(C,{keyPath:"compositeKey"})}}}catch(t){e(g.create("storage-open",{originalErrorMessage:t==null?void 0:t.message}))}})}class X{getLastFetchStatus(){return this.get("last_fetch_status")}setLastFetchStatus(e){return this.set("last_fetch_status",e)}getLastSuccessfulFetchTimestampMillis(){return this.get("last_successful_fetch_timestamp_millis")}setLastSuccessfulFetchTimestampMillis(e){return this.set("last_successful_fetch_timestamp_millis",e)}getLastSuccessfulFetchResponse(){return this.get("last_successful_fetch_response")}setLastSuccessfulFetchResponse(e){return this.set("last_successful_fetch_response",e)}getActiveConfig(){return this.get("active_config")}setActiveConfig(e){return this.set("active_config",e)}getActiveConfigEtag(){return this.get("active_config_etag")}setActiveConfigEtag(e){return this.set("active_config_etag",e)}getActiveExperiments(){return this.get("active_experiments")}setActiveExperiments(e){return this.set("active_experiments",e)}getThrottleMetadata(){return this.get("throttle_metadata")}setThrottleMetadata(e){return this.set("throttle_metadata",e)}deleteThrottleMetadata(){return this.delete("throttle_metadata")}getCustomSignals(){return this.get("custom_signals")}getRealtimeBackoffMetadata(){return this.get("realtime_backoff_metadata")}setRealtimeBackoffMetadata(e){return this.set("realtime_backoff_metadata",e)}getActiveConfigTemplateVersion(){return this.get("last_known_template_version")}setActiveConfigTemplateVersion(e){return this.set("last_known_template_version",e)}}class Ae extends X{constructor(e,t,s,i=Re()){super(),this.appId=e,this.appName=t,this.namespace=s,this.openDbPromise=i}async setCustomSignals(e){const s=(await this.openDbPromise).transaction([C],"readwrite"),i=await this.getWithTransaction("custom_signals",s),a=J(e,i||{});return await this.setWithTransaction("custom_signals",a,s),a}async getWithTransaction(e,t){return new Promise((s,i)=>{const a=t.objectStore(C),r=this.createCompositeKey(e);try{const o=a.get(r);o.onerror=c=>{i(v(c,"storage-get"))},o.onsuccess=c=>{const l=c.target.result;s(l?l.value:void 0)}}catch(o){i(g.create("storage-get",{originalErrorMessage:o==null?void 0:o.message}))}})}async setWithTransaction(e,t,s){return new Promise((i,a)=>{const r=s.objectStore(C),o=this.createCompositeKey(e);try{const c=r.put({compositeKey:o,value:t});c.onerror=l=>{a(v(l,"storage-set"))},c.onsuccess=()=>{i()}}catch(c){a(g.create("storage-set",{originalErrorMessage:c==null?void 0:c.message}))}})}async get(e){const s=(await this.openDbPromise).transaction([C],"readonly");return this.getWithTransaction(e,s)}async set(e,t){const i=(await this.openDbPromise).transaction([C],"readwrite");return this.setWithTransaction(e,t,i)}async delete(e){const t=await this.openDbPromise;return new Promise((s,i)=>{const r=t.transaction([C],"readwrite").objectStore(C),o=this.createCompositeKey(e);try{const c=r.delete(o);c.onerror=l=>{i(v(l,"storage-delete"))},c.onsuccess=()=>{s()}}catch(c){i(g.create("storage-delete",{originalErrorMessage:c==null?void 0:c.message}))}})}createCompositeKey(e){return[this.appId,this.appName,this.namespace,e].join()}}class Ie extends X{constructor(){super(...arguments),this.storage={}}async get(e){return Promise.resolve(this.storage[e])}async set(e,t){return this.storage[e]=t,Promise.resolve(void 0)}async delete(e){return this.storage[e]=void 0,Promise.resolve()}async setCustomSignals(e){const t=this.storage.custom_signals||{};return this.storage.custom_signals=J(e,t),Promise.resolve(this.storage.custom_signals)}}function J(n,e){const t={...e,...n},s=Object.fromEntries(Object.entries(t).filter(([i,a])=>a!==null).map(([i,a])=>typeof a=="number"?[i,a.toString()]:[i,a]));if(Object.keys(s).length>x)throw g.create("custom-signal-max-allowed-signals",{maxSignals:x});return s}/**
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
 */class Fe{constructor(e){this.storage=e}getLastFetchStatus(){return this.lastFetchStatus}getLastSuccessfulFetchTimestampMillis(){return this.lastSuccessfulFetchTimestampMillis}getActiveConfig(){return this.activeConfig}getCustomSignals(){return this.customSignals}async loadFromStorage(){const e=this.storage.getLastFetchStatus(),t=this.storage.getLastSuccessfulFetchTimestampMillis(),s=this.storage.getActiveConfig(),i=this.storage.getCustomSignals(),a=await e;a&&(this.lastFetchStatus=a);const r=await t;r&&(this.lastSuccessfulFetchTimestampMillis=r);const o=await s;o&&(this.activeConfig=o);const c=await i;c&&(this.customSignals=c)}setLastFetchStatus(e){return this.lastFetchStatus=e,this.storage.setLastFetchStatus(e)}setLastSuccessfulFetchTimestampMillis(e){return this.lastSuccessfulFetchTimestampMillis=e,this.storage.setLastSuccessfulFetchTimestampMillis(e)}setActiveConfig(e){return this.activeConfig=e,this.storage.setActiveConfig(e)}async setCustomSignals(e){this.customSignals=await this.storage.setCustomSignals(e)}}/**
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
 */class ke{constructor(e){this.allowedEvents_=e,this.listeners_={},I(Array.isArray(e)&&e.length>0,"Requires a non-empty array")}trigger(e,...t){if(Array.isArray(this.listeners_[e])){const s=[...this.listeners_[e]];for(let i=0;i<s.length;i++)s[i].callback.apply(s[i].context,t)}}on(e,t,s){this.validateEventType_(e),this.listeners_[e]=this.listeners_[e]||[],this.listeners_[e].push({callback:t,context:s});const i=this.getInitialEvent(e);i&&t.apply(s,i)}off(e,t,s){this.validateEventType_(e);const i=this.listeners_[e]||[];for(let a=0;a<i.length;a++)if(i[a].callback===t&&(!s||s===i[a].context)){i.splice(a,1);return}}validateEventType_(e){I(this.allowedEvents_.find(t=>t===e),"Unknown event: "+e)}}/**
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
 */class F extends ke{static getInstance(){return new F}constructor(){super(["visible"]);let e,t;typeof document<"u"&&typeof document.addEventListener<"u"&&(typeof document.hidden<"u"?(t="visibilitychange",e="hidden"):typeof document.mozHidden<"u"?(t="mozvisibilitychange",e="mozHidden"):typeof document.msHidden<"u"?(t="msvisibilitychange",e="msHidden"):typeof document.webkitHidden<"u"&&(t="webkitvisibilitychange",e="webkitHidden")),this.visible_=!0,t&&document.addEventListener(t,()=>{const s=!document[e];s!==this.visible_&&(this.visible_=s,this.trigger("visible",s))},!1)}getInitialEvent(e){return I(e==="visible","Unknown event type: "+e),[this.visible_]}}/**
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
 */const Le="X-Goog-Api-Key",Oe="X-Goog-Firebase-Installations-Auth",A=8,U=3,H=-1,V=0,$="featureDisabled",K="retryIntervalSeconds",j="latestTemplateVersionNumber";class Pe{constructor(e,t,s,i,a,r,o,c,l,m){this.firebaseInstallations=e,this.storage=t,this.sdkVersion=s,this.namespace=i,this.projectId=a,this.apiKey=r,this.appId=o,this.logger=c,this.storageCache=l,this.cachingClient=m,this.observers=new Set,this.isConnectionActive=!1,this.isRealtimeDisabled=!1,this.httpRetriesRemaining=A,this.isInBackground=!1,this.decoder=new TextDecoder("utf-8"),this.isClosingConnection=!1,this.propagateError=h=>this.observers.forEach(u=>{var b;return(b=u.error)==null?void 0:b.call(u,h)}),this.isStatusCodeRetryable=h=>!h||[408,429,502,503,504].includes(h),this.setRetriesRemaining(),F.getInstance().on("visible",this.onVisibilityChange,this)}async setRetriesRemaining(){const e=await this.storage.getRealtimeBackoffMetadata(),t=(e==null?void 0:e.numFailedStreams)||0;this.httpRetriesRemaining=Math.max(A-t,1)}async updateBackoffMetadataWithLastFailedStreamConnectionTime(e){var i;const t=(((i=await this.storage.getRealtimeBackoffMetadata())==null?void 0:i.numFailedStreams)||0)+1,s=W(t,6e4,2);await this.storage.setRealtimeBackoffMetadata({backoffEndTimeMillis:new Date(e.getTime()+s),numFailedStreams:t})}async updateBackoffMetadataWithRetryInterval(e){const t=Date.now(),s=e*1e3,i=new Date(t+s);await this.storage.setRealtimeBackoffMetadata({backoffEndTimeMillis:i,numFailedStreams:0}),await this.retryHttpConnectionWhenBackoffEnds()}async closeRealtimeHttpConnection(){if(!this.isClosingConnection){this.isClosingConnection=!0;try{this.reader&&await this.reader.cancel()}catch{this.logger.debug("Failed to cancel the reader, connection was lost.")}finally{this.reader=void 0}this.controller&&(await this.controller.abort(),this.controller=void 0),this.isClosingConnection=!1}}async resetRealtimeBackoff(){await this.storage.setRealtimeBackoffMetadata({backoffEndTimeMillis:new Date(-1),numFailedStreams:0})}resetRetryCount(){this.httpRetriesRemaining=A}async establishRealtimeConnection(e,t,s,i){const a=await this.storage.getActiveConfigEtag(),r=await this.storage.getActiveConfigTemplateVersion(),o={[Le]:this.apiKey,[Oe]:s,"Content-Type":"application/json",Accept:"application/json","If-None-Match":a||"*","Content-Encoding":"gzip"},c={project:this.projectId,namespace:this.namespace,lastKnownVersionNumber:r,appId:this.appId,sdkVersion:this.sdkVersion,appInstanceId:t};return await fetch(e,{method:"POST",headers:o,body:JSON.stringify(c),signal:i})}getRealtimeUrl(){const t=`${window.FIREBASE_REMOTE_CONFIG_URL_BASE||"https://firebaseremoteconfigrealtime.googleapis.com"}/v1/projects/${this.projectId}/namespaces/${this.namespace}:streamFetchInvalidations?key=${this.apiKey}`;return new URL(t)}async createRealtimeConnection(){const[e,t]=await Promise.all([this.firebaseInstallations.getId(),this.firebaseInstallations.getToken(!1)]);this.controller=new AbortController;const s=this.getRealtimeUrl();return await this.establishRealtimeConnection(s,e,t,this.controller.signal)}async retryHttpConnectionWhenBackoffEnds(){let e=await this.storage.getRealtimeBackoffMetadata();e||(e={backoffEndTimeMillis:new Date(H),numFailedStreams:V});const t=new Date(e.backoffEndTimeMillis).getTime(),s=Date.now(),i=Math.max(0,t-s);await this.makeRealtimeHttpConnection(i)}setIsHttpConnectionRunning(e){this.isConnectionActive=e}checkAndSetHttpConnectionFlagIfNotRunning(){const e=this.canEstablishStreamConnection();return e&&this.setIsHttpConnectionRunning(!0),e}fetchResponseIsUpToDate(e,t){return e.config!=null&&e.templateVersion?e.templateVersion>=t:this.storageCache.getLastFetchStatus()==="success"}parseAndValidateConfigUpdateMessage(e){const t=e.indexOf("{"),s=e.indexOf("}",t);return t<0||s<0||t>=s?"":e.substring(t,s+1)}isEventListenersEmpty(){return this.observers.size===0}getRandomInt(e){return Math.floor(Math.random()*e)}executeAllListenerCallbacks(e){this.observers.forEach(t=>t.next(e))}getChangedParams(e,t){const s=new Set,i=new Set(Object.keys(e||{})),a=new Set(Object.keys(t||{}));for(const r of i)(!a.has(r)||e[r]!==t[r])&&s.add(r);for(const r of a)i.has(r)||s.add(r);return s}async fetchLatestConfig(e,t){const s=e-1,i=U-s,a=this.storageCache.getCustomSignals();a&&this.logger.debug(`Fetching config with custom signals: ${JSON.stringify(a)}`);const r=new Y;try{const o={cacheMaxAgeMillis:0,signal:r,customSignals:a,fetchType:"REALTIME",fetchAttempt:i},c=await this.cachingClient.fetch(o);let l=await this.storage.getActiveConfig();if(!this.fetchResponseIsUpToDate(c,t)){this.logger.debug("Fetched template version is the same as SDK's current version. Retrying fetch."),await this.autoFetch(s,t);return}if(c.config==null){this.logger.debug("The fetch succeeded, but the backend had no updates.");return}l==null&&(l={});const m=this.getChangedParams(c.config,l);if(m.size===0){this.logger.debug("Config was fetched, but no params changed.");return}const h={getUpdatedKeys(){return new Set(m)}};this.executeAllListenerCallbacks(h)}catch(o){const c=o instanceof Error?o.message:String(o),l=g.create("update-not-fetched",{originalErrorMessage:`Failed to auto-fetch config update: ${c}`});this.propagateError(l)}}async autoFetch(e,t){if(e===0){const a=g.create("update-not-fetched",{originalErrorMessage:"Unable to fetch the latest version of the template."});this.propagateError(a);return}const i=this.getRandomInt(4)*1e3;await new Promise(a=>setTimeout(a,i)),await this.fetchLatestConfig(e,t)}async handleNotifications(e){let t,s="";for(;;){const{done:i,value:a}=await e.read();if(i)break;if(t=this.decoder.decode(a,{stream:!0}),s+=t,t.includes("}")){if(s=this.parseAndValidateConfigUpdateMessage(s),s.length===0)continue;try{const r=JSON.parse(s);if(this.isEventListenersEmpty())break;if($ in r&&r[$]===!0){const o=g.create("realtime-unavailable",{originalErrorMessage:"The server is temporarily unavailable. Try again in a few minutes."});this.propagateError(o);break}if(j in r){const o=await this.storage.getActiveConfigTemplateVersion(),c=Number(r[j]);o&&c>o&&await this.autoFetch(U,c)}if(K in r){const o=Number(r[K]);await this.updateBackoffMetadataWithRetryInterval(o)}}catch(r){this.logger.debug("Unable to parse latest config update message.",r);const o=r instanceof Error?r.message:String(r);this.propagateError(g.create("update-message-invalid",{originalErrorMessage:o}))}s=""}}}async listenForNotifications(e){try{await this.handleNotifications(e)}catch{this.isInBackground||this.logger.debug("Real-time connection was closed due to an exception.")}}async prepareAndBeginRealtimeHttpStream(){if(!this.checkAndSetHttpConnectionFlagIfNotRunning())return;let e=await this.storage.getRealtimeBackoffMetadata();e||(e={backoffEndTimeMillis:new Date(H),numFailedStreams:V});const t=e.backoffEndTimeMillis.getTime();if(Date.now()<t){await this.retryHttpConnectionWhenBackoffEnds();return}let s,i;try{if(s=await this.createRealtimeConnection(),i=s.status,s.ok&&s.body){this.resetRetryCount(),await this.resetRealtimeBackoff();const a=s.body.getReader();this.reader=a,await this.listenForNotifications(a)}}catch(a){this.isInBackground?this.resetRetryCount():this.logger.debug("Exception connecting to real-time RC backend. Retrying the connection...:",a)}finally{await this.closeRealtimeHttpConnection(),this.setIsHttpConnectionRunning(!1);const a=!this.isInBackground&&(i===void 0||this.isStatusCodeRetryable(i));if(a&&await this.updateBackoffMetadataWithLastFailedStreamConnectionTime(new Date),a||s!=null&&s.ok)await this.retryHttpConnectionWhenBackoffEnds();else{const r=`Unable to connect to the server. HTTP status code: ${i}`,o=g.create("stream-error",{originalErrorMessage:r});this.propagateError(o)}}}canEstablishStreamConnection(){const e=this.observers.size>0,t=!this.isRealtimeDisabled,s=!this.isConnectionActive,i=!this.isInBackground;return e&&t&&s&&i}async makeRealtimeHttpConnection(e){if(this.canEstablishStreamConnection()){if(this.httpRetriesRemaining>0)this.httpRetriesRemaining--,await new Promise(t=>setTimeout(t,e)),this.prepareAndBeginRealtimeHttpStream();else if(!this.isInBackground){const t=g.create("stream-error",{originalErrorMessage:"Unable to connect to the server. Check your connection and try again."});this.propagateError(t)}}}async beginRealtime(){this.observers.size>0&&await this.makeRealtimeHttpConnection(0)}addObserver(e){this.observers.add(e),this.beginRealtime()}removeObserver(e){this.observers.has(e)&&this.observers.delete(e)}async onVisibilityChange(e){this.isInBackground=!e,e?e&&await this.beginRealtime():await this.closeRealtimeHttpConnection()}}/**
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
 */function xe(){ie(new ae(q,n,"PUBLIC").setMultipleInstances(!0)),L(M,P),L(M,P,"esm2020");function n(e,{options:t}){const s=e.getProvider("app").getImmediate(),i=e.getProvider("installations-internal").getImmediate(),a=e.getProvider("analytics-internal"),{projectId:r,apiKey:o,appId:c}=s.options;if(!r)throw g.create("registration-project-id");if(!o)throw g.create("registration-api-key");if(!c)throw g.create("registration-app-id");const l=(t==null?void 0:t.templateId)||"firebase",m=z()?new Ae(c,s.name,l):new Ie,h=new Fe(m),u=new ne(M);u.logLevel=S.ERROR;const b=new Ce(i,O,l,r,o,c),w=new we(b,m),p=new pe(w,m,h,u),y=new Pe(i,m,O,l,r,o,c,u,h,p),E=new ve(s,p,h,m,u,y,a);return fe(E),E}}/**
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
 */async function ze(n){return n=d(n),await de(n),ue(n)}async function Ge(){if(!z())return!1;try{return await se()}catch{return!1}}xe();export{ue as activate,fe as ensureInitialized,ze as fetchAndActivate,de as fetchConfig,Be as getAll,Ue as getBoolean,He as getNumber,Ne as getRemoteConfig,Ve as getString,T as getValue,Ge as isSupported,je as onConfigUpdate,Ke as setCustomSignals,$e as setLogLevel};
