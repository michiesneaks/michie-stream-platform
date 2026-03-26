function router() {
  var path  = window.location.pathname;
  var pages = ['index.html', 'listen.html', 'creators.html', 'marketplace.html', 'profile.html', 'live_studio.html'];
  if (!pages.some(function (page) { return path.includes(page); })) {
    window.location.href = 'index.html';
  }
}

window.addEventListener('load', router);

document.querySelectorAll('.nav-link').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    window.location.href = link.getAttribute('href');
  });
});
