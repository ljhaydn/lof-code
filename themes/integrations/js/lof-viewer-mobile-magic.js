/**
 * LOF VIEWER HYBRID - MOBILE MAGIC ENHANCEMENTS
 * Adds confetti burst on mobile tap and other delight moments
 */

(function() {
  'use strict';
  
  // Only run on mobile
  const isMobile = window.innerWidth < 700;
  
  if (!isMobile) return;
  
  /**
   * Create confetti burst at position
   */
  function createConfettiBurst(x, y) {
    const colors = ['#E91E63', '#FFD700', '#FFFFFF', '#F FC', '#FF69B4'];
    const particleCount = 6;
    
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'confetti-particle';
      
      // Random color
      particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      
      // Start at click position
      particle.style.left = x + 'px';
      particle.style.top = y + 'px';
      
      // Random direction
      const angle = (Math.PI * 2 * i) / particleCount;
      const velocity = 50 + Math.random() * 50;
      const tx = Math.cos(angle) * velocity;
      const ty = Math.sin(angle) * velocity;
      
      particle.style.setProperty('--tx', tx + 'px');
      particle.style.setProperty('--ty', ty + 'px');
      
      document.body.appendChild(particle);
      
      // Remove after animation
      setTimeout(() => {
        particle.remove();
      }, 800);
    }
  }
  
  /**
   * Add confetti CSS if not exists
   */
  function addConfettiStyles() {
    if (document.getElementById('lof-confetti-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'lof-confetti-styles';
    style.textContent = `
      .confetti-particle {
        position: fixed;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        pointer-events: none;
        z-index: 10000;
        animation: confetti-burst 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      
      @keyframes confetti-burst {
        0% {
          transform: translate(0, 0) rotate(0deg) scale(1);
          opacity: 1;
        }
        100% {
          transform: translate(var(--tx, 0), var(--ty, 100px)) rotate(720deg) scale(0);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * Handle card tap
   */
  function handleCardTap(event) {
    const card = event.currentTarget;
    const button = event.target.closest('.rf-card-btn');
    
    // Only trigger on button clicks
    if (!button || button.disabled) return;
    
    // Add tap animation class
    card.classList.add('just-tapped');
    setTimeout(() => {
      card.classList.remove('just-tapped');
    }, 600);
    
    // Create confetti at click position
    const rect = card.getBoundingClientRect();
    const x = event.clientX || (rect.left + rect.width / 2);
    const y = event.clientY || (rect.top + rect.height / 2);
    
    createConfettiBurst(x, y);
    
    // Haptic feedback (if supported)
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  }
  
  /**
   * Initialize on DOM ready
   */
  function init() {
    addConfettiStyles();
    
    // Wait for cards to be rendered
    const observer = new MutationObserver(() => {
      const cards = document.querySelectorAll('.rf-card');
      
      cards.forEach(card => {
        // Only add once
        if (card.dataset.tapEnhanced) return;
        card.dataset.tapEnhanced = 'true';
        
        card.addEventListener('click', handleCardTap);
      });
    });
    
    // Observe the grid for new cards
    const grid = document.getElementById('rf-grid');
    if (grid) {
      observer.observe(grid, {
        childList: true,
        subtree: true
      });
      
      // Also run on existing cards
      const cards = document.querySelectorAll('.rf-card');
      cards.forEach(card => {
        if (card.dataset.tapEnhanced) return;
        card.dataset.tapEnhanced = 'true';
        card.addEventListener('click', handleCardTap);
      });
    }
  }
  
  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
