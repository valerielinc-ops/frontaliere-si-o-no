// Public REXX initializer's cookie-check contract, without private page values.
export const rexxGuestSessionScript = `var upload={InitChunckedUpload:function(elem_id,handler,chunkSize,field_name,options,session_name,session_id){
if(upload.cookie_allowed==null){$.ajax({url:base_url_rexx+'cookiecheck-cc0.html'+(session_id===''?'':'?'+session_name+'='+session_id),async:false,method:'GET',dataType:'json',success:function(data){if(typeof data['cookie_allowed']!=='undefined'){upload.cookie_allowed=data['cookie_allowed'];upload.session_id=data['session_id'];}else{upload.cookie_allowed=false;}}});}
}};`;
