// splitty embed loader
// <script src="https://splitty.chat/embed.js" data-chat="CHAT_ID" async></script>
// Swaps itself for an iframe of the read-only chat and keeps the frame sized
// to its content via `splitty:height` messages from inside the frame.
(function () {
  var script = document.currentScript;
  if (!script) return;
  var ORIGIN = 'https://splitty.chat';
  var id = script.getAttribute('data-chat') || script.getAttribute('data-id') || '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
  var minHeight = parseInt(script.getAttribute('data-height'), 10) || 480;

  var frame = document.createElement('iframe');
  frame.src = ORIGIN + '/embed/' + id;
  frame.style.cssText = 'width:100%;border:0;border-radius:12px;min-height:' + minHeight + 'px';
  frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('title', 'Splitty chat');
  script.parentNode.replaceChild(frame, script);

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.type !== 'splitty:height' || d.id !== id) return;
    var h = Number(d.height);
    if (!(h > 0)) return;
    frame.style.height = Math.max(h, minHeight) + 'px';
  });
})();
