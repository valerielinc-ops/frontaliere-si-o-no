// Public REXX common.js protocol shape: the timezone branch alone, with no
// company, posting or candidate data. Exact AST, not a suffix allow-list.
export const rexxTimeZoneScript = `
if ($('#timezone').length) {
  try {
    if ($('#timezone').val() === null || $('#timezone').val() == '') {
      var timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
      $.ajax({
        url: base_url_rexx + 'timezone.html',
        dataType: 'json', type: 'POST',
        data: { 'name': timezoneName },
        success: function (response) {
          if (response.success) {
            $('#timezone').val(response.id);
            if ($('#timezone-button').length) {
              $('#timezone-button').find('.ui-selectmenu-text').text(timezoneName);
            }
          }
        }
      });
    }
  } catch (e) {}
}`;
