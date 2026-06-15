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
        document.body.style.overflow = 'hidden';
      } else {
        iconMenu.style.display = 'block';
        iconClose.style.display = 'none';
        document.body.style.overflow = '';
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

  // FAB Logic
  const fabToggleBtn = document.getElementById('fab-toggle-btn');
  const fabMenu = document.querySelector('.fab-menu');

  if (fabToggleBtn && fabMenu) {
    const iconChat = fabToggleBtn.querySelector('.icon-chat');
    const iconClose = fabToggleBtn.querySelector('.icon-close');

    const toggleFab = () => {
      const isActive = fabMenu.classList.contains('fab-active');
      fabMenu.classList.toggle('fab-active');

      if (!isActive) {
        iconChat.style.display = 'none';
        iconClose.style.display = 'block';
      } else {
        iconChat.style.display = 'block';
        iconClose.style.display = 'none';
      }
    };

    fabToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFab();
    });

    document.addEventListener('click', (e) => {
      if (fabMenu.classList.contains('fab-active') && !e.target.closest('.fab-wrapper')) {
        toggleFab();
      }
    });
  }
});
