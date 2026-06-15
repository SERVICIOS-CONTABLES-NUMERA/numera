document.addEventListener('DOMContentLoaded', () => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, {
    threshold: .15
  });

  document.querySelectorAll('.fade').forEach((el) => {
    observer.observe(el);
  });
});
