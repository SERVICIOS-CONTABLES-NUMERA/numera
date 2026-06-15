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

  // Mobile Menu Logic
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const navLinks = document.querySelector('.nav-links');
  
  if (mobileMenuBtn && navLinks) {
    const iconMenu = mobileMenuBtn.querySelector('.icon-menu');
    const iconClose = mobileMenuBtn.querySelector('.icon-close');

    const toggleMenu = () => {
      const isExpanded = mobileMenuBtn.getAttribute('aria-expanded') === 'true';
      mobileMenuBtn.setAttribute('aria-expanded', !isExpanded);
      navLinks.classList.toggle('nav-active');
      
      if (!isExpanded) {
        iconMenu.style.display = 'none';
        iconClose.style.display = 'block';
      } else {
        iconMenu.style.display = 'block';
        iconClose.style.display = 'none';
      }
    };

    mobileMenuBtn.addEventListener('click', toggleMenu);

    // Close menu when a link is clicked
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        if (navLinks.classList.contains('nav-active')) {
          toggleMenu();
        }
      });
    });
  }
});
