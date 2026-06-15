/**
 * ============================================================
 * RADAR FISCAL INTELIGENTE v2 — radar.js
 *
 * Motor de clasificación semántica profesional.
 * Taxonomía: Fiscal · Contable · Legal · Legislativo ·
 *            Financiero · Empresarial · Cripto regulatorio
 *
 * Módulos:
 *   ClasificadorFiscal  — scoring, clasificación, blacklist
 *   State               — estado reactivo global
 *   Fetch               — carga JSON con cache
 *   Process             — pipeline de datos
 *   Render*             — 7 vistas de contenido
 *   Filters             — controles avanzados de filtrado
 *   Init                — arranque
 *
 * Sin dependencias externas. Vanilla JS ES2020.
 * ============================================================
 */

(function RadarFiscalV2() {
  'use strict';

  /* ════════════════════════════════════════════════════════
     MOTOR DE CLASIFICACIÓN — ClasificadorFiscal
     ════════════════════════════════════════════════════════ */

  const ClasificadorFiscal = {

    rules: null,

    /** Carga las reglas desde clasificador.json */
    async loadRules() {
      try {
        const res = await fetch('./data/clasificador.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.rules = await res.json();
        return true;
      } catch (e) {
        console.error('[Clasificador] Error cargando reglas:', e);
        this.rules = { categorias: {}, whitelist: [], blacklist: [], fuentes: {}, config: { score_minimo: 15, whitelist_bonus: 25 }, terminos_mexico: [] };
        return false;
      }
    },

    /** Extrae texto normalizado de un ítem para análisis */
    getText(item) {
      return [
        item.titulo, item.descripcion, item.resumen,
        item.etapa, item.fuente, item.categoria, item.categoria_manual,
        item.seccion, item.tipo,
        ...(item.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
    },

    /** Verifica si un ítem debe ser rechazado por la blacklist */
    isBlacklisted(item) {
      if (!this.rules?.blacklist?.length) return false;
      const text = this.getText(item);
      return this.rules.blacklist.some(term =>
        text.includes(term.toLowerCase())
      );
    },

    /** Obtiene el bonus por fuente según jerarquía */
    getSourceBonus(fuente) {
      if (!this.rules?.fuentes) return 4;
      const src = this.rules.fuentes[fuente];
      return src ? src.bonus : 4;
    },

    /** Bonus de recencia: ítem más nuevo → más puntos */
    getRecencyBonus(fecha) {
      const days = (Date.now() - new Date(fecha).getTime()) / 86400000;
      if (days <= 0.5) return 15;
      if (days <= 1)   return 13;
      if (days <= 3)   return 10;
      if (days <= 7)   return 7;
      if (days <= 14)  return 4;
      if (days <= 30)  return 1;
      return 0;
    },

    /** Bonus si el ítem menciona alguna entidad de la whitelist */
    getWhitelistBonus(item) {
      if (!this.rules?.whitelist?.length) return 0;
      const text = this.getText(item);
      const hit = this.rules.whitelist.some(e => text.includes(e.toLowerCase()));
      return hit ? (this.rules.config?.whitelist_bonus || 25) : 0;
    },

    /** Calcula puntos de keywords y devuelve keywords detectadas */
    getKeywordScore(item) {
      if (!this.rules?.categorias) return { score: 0, matched: [] };
      const text  = this.getText(item);
      let   total = 0;
      const matched = new Set();

      for (const cat of Object.values(this.rules.categorias)) {
        for (const kw of (cat.keywords || [])) {
          if (text.includes(kw.term.toLowerCase())) {
            total += kw.weight;
            matched.add(kw.term);
          }
        }
      }
      return { score: total, matched: [...matched].slice(0, 5) };
    },

    /**
     * Clasifica un ítem en la taxonomía de 7 categorías.
     * Si tiene categoria_manual, la respeta.
     * Si no, elige la categoría con mayor puntaje de keywords.
     */
    classify(item) {
      if (item.categoria_manual && this.rules?.categorias?.[item.categoria_manual]) {
        return item.categoria_manual;
      }
      if (!this.rules?.categorias) return 'fiscal';

      const text = this.getText(item);
      let bestCat   = 'fiscal';
      let bestScore = 0;

      for (const [catId, cat] of Object.entries(this.rules.categorias)) {
        let catScore = 0;
        for (const kw of (cat.keywords || [])) {
          if (text.includes(kw.term.toLowerCase())) catScore += kw.weight;
        }
        if (catScore > bestScore) {
          bestScore = catScore;
          bestCat   = catId;
        }
      }
      return bestCat;
    },

    /** Detecta nivel de impacto por score */
    detectImpact(score) {
      if (score >= 70) return 'alto';
      if (score >= 35) return 'medio';
      return 'bajo';
    },

    /** Determina si un ítem es relevante para México */
    isMexicoRelevant(item) {
      if (item.mexico_relevante !== undefined) return Boolean(item.mexico_relevante);
      const text  = this.getText(item);
      const terms = this.rules?.terminos_mexico || ['mexico', 'méxico', 'sat', 'dof', 'shcp', 'banxico', 'imcp', 'cnbv', 'imss'];
      return terms.some(t => text.includes(t.toLowerCase()));
    },

    /** Elimina duplicados por similitud de título (distancia simplificada) */
    dedup(items) {
      const seen = new Map();
      return items.filter(item => {
        const key = item.titulo.toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, '').slice(0, 60);
        if (seen.has(key)) return false;
        seen.set(key, true);
        return true;
      });
    },

    /**
     * Pipeline completo: valida → score → clasifica → enriquece
     * Retorna ítem enriquecido o null si fue rechazado.
     */
    process(item) {
      if (this.isBlacklisted(item)) return null;

      // Restricción de Arquitectura SOURCE-FIRST:
      // Validar si el ítem está vinculado a un documento oficial verificado exacto.
      const hasOfficialSource = item.source_url && item.verified === true;
      let sinDocumentoOficial = false;

      if (!hasOfficialSource) {
        const idPrefix = String(item.id || '').split('-')[0];
        // En secciones críticas (vigilancia, alertas, dof, legislativo, regulatorio), NO se publica si no tiene fuente oficial exacta.
        if (['VIG', 'ALT', 'DOF', 'LEG', 'REG'].includes(idPrefix)) {
          return null; // Omitir/no publicar
        }
        // Para noticias o contexto general, permitimos publicar pero marcando explícitamente "sin documento oficial"
        sinDocumentoOficial = true;
      }

      const { score: kwScore, matched } = this.getKeywordScore(item);
      const sourceBonus    = this.getSourceBonus(item.fuente);
      const recencyBonus   = this.getRecencyBonus(item.fecha);
      const whitelistBonus = this.getWhitelistBonus(item);

      // Score crudo → normalizado 0–100
      const raw        = kwScore + sourceBonus + recencyBonus + whitelistBonus;
      const scoreValue = Math.min(100, Math.round(raw));
      const minScore   = this.rules?.config?.score_minimo ?? 15;

      if (scoreValue < minScore) return null;

      return {
        ...item,
        _score:     scoreValue,
        _keywords:  matched,
        _categoria: this.classify(item),
        _impacto:   item.impacto || this.detectImpact(scoreValue),
        _mexico:    this.isMexicoRelevant(item),
        sin_documento_oficial: sinDocumentoOficial,
      };
    },

    /** Procesa un array completo de ítems */
    processArray(items = []) {
      return this.dedup(
        items.map(i => this.process(i)).filter(Boolean)
      );
    },
  };

  /* ════════════════════════════════════════════════════════
     GESTOR DE URLs — UrlManager
     ════════════════════════════════════════════════════════ */

  const UrlManager = {

    catalog: null,

    /** Carga el catálogo de fuentes canónicas verificadas */
    async load() {
      try {
        const res = await fetch('./data/fuentes_canonicas.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.catalog = await res.json();
        console.log('[UrlManager] Catálogo cargado:', Object.keys(this.catalog.fuentes || {}).length, 'fuentes');
        return true;
      } catch (e) {
        console.warn('[UrlManager] No se cargó fuentes_canonicas.json:', e.message);
        this.catalog = null;
        return false;
      }
    },

    /** Obtiene URL canónica de una fuente y sección */
    getCanonical(fuente, seccion = 'inicio') {
      const f = this.catalog?.fuentes?.[fuente];
      if (!f) return null;
      return f.urls?.[seccion] || f.url_base || null;
    },

    /** Score de confianza de la fuente (0–100) */
    getConfianza(fuente) {
      return this.catalog?.fuentes?.[fuente]?.confianza ?? 40;
    },

    /** Tier de la fuente (1 = oficial primaria … 5 = genérico) */
    getTier(fuente) {
      return this.catalog?.fuentes?.[fuente]?.tier ?? 5;
    },

    /**
     * Verifica si una URL pertenece a un dominio oficial conocido.
     * Solo compara contra url_base del catálogo — no valida en red.
     */
    /**
     * Verifica si una URL pertenece a un dominio oficial conocido y es segura.
     * Solo permite URLs públicas en el catálogo, PDFs legislativos estáticos, o dominios oficiales raíz sin rutas profundas no verificadas.
     */
    isVerified(url) {
      if (!url || url === '#') return false;
      if (!this.catalog?.fuentes) return false;

      // 1. Eliminar de raíz enlaces protegidos del SAT o rutas que requieran autenticación / den 403
      if (url.includes('sat.gob.mx') && 
          (url.includes('/consultas/') || url.includes('/tramites/') || url.includes('/declaracion') || url.includes('/buzon') || url.includes('/privado'))) {
        return false;
      }

      // 2. Verificar contra URLs explícitas del catálogo de fuentes canónicas
      for (const f of Object.values(this.catalog.fuentes)) {
        if (f.urls) {
          for (const u of Object.values(f.urls)) {
            if (url === u) return true;
          }
        }
        if (url === f.url_base) return true;
      }

      // 3. Permitir PDFs oficiales de Leyes de Diputados
      if (url.startsWith('https://www.diputados.gob.mx/LeyesBiblio/pdf/') && url.endsWith('.pdf')) {
        return true;
      }

      // 4. Permitir gacetas oficiales y urls legislativas públicas básicas
      if (url.startsWith('https://gaceta.diputados.gob.mx') && !url.includes('?')) {
        return true;
      }

      // 5. Permitir dominios base verificados sin paths dinámicos/largas sospechosas
      const allowedBases = [
        'https://www.dof.gob.mx',
        'https://www.senado.gob.mx',
        'http://sil.gobernacion.gob.mx/portal',
        'https://www.gob.mx/hacienda',
        'https://www.gob.mx/hacienda/prensa',
        'https://www.banxico.org.mx',
        'https://imcp.org.mx'
      ];
      if (allowedBases.some(base => url === base || url.startsWith(base + '/')) && !url.includes('//sat.gob.mx')) {
        try {
          const parsed = new URL(url);
          if (parsed.pathname.split('/').length <= 5) {
            return true;
          }
        } catch (e) {
          return false;
        }
      }

      return false;
    },

    /**
     * Construye el array de links para un ítem.
     * En el modelo SOURCE-FIRST, el botón principal (primero de la lista) DEBE ser el documento oficial exacto.
     * Si no hay, o después de filtrar enlaces inválidos de SAT, agregamos fallbacks públicos verificados alternativos.
     */
    buildLinks(item) {
      let links = [];

      // 1. Agregar el documento oficial exacto como enlace principal (primer botón)
      if (item.source_url) {
        let label = 'Ver documento oficial';
        let icono = '🏛️';
        let tipo  = 'oficial';

        if (item.source_type === 'pdf_oficial' || item.source_url.endsWith('.pdf')) {
          label = 'Ver PDF';
          icono = '📄';
          tipo  = 'pdf';
        } else if (item.source_type === 'sil' || item.source_type === 'iniciativa') {
          label = 'Ver iniciativa';
          icono = '⚖️';
          tipo  = 'iniciativa';
        } else if (item.source_type === 'dof') {
          label = 'Ver en DOF';
          icono = '📋';
          tipo  = 'dof';
        } else if (item.source_type === 'gaceta') {
          label = 'Ver en Gaceta';
          icono = '📑';
          tipo  = 'gaceta';
        } else if (item.source_type === 'comunicado_shcp' || item.source_type === 'comunicado_sat') {
          label = 'Ver comunicado oficial';
          icono = '📰';
          tipo  = 'oficial';
        }

        links.push({
          tipo:       tipo,
          label:      label,
          url:        item.source_url,
          verificado: item.verified,
          es_publico: true,
          icono:      icono,
        });
      }

      // 2. Filtrar y agregar otros enlaces del JSON como secundarios (evitando duplicar el principal)
      if (item.links?.length) {
        const secondary = item.links.filter(l => {
          if (!l?.url || l.url === '#') return false;
          if (l.url === item.source_url) return false; // Evitar duplicar el principal
          // Excluir links protegidos del SAT
          if (l.url.includes('sat.gob.mx') && 
              (l.url.includes('/consultas/') || l.url.includes('/tramites/') || l.url.includes('/declaracion') || l.url.includes('/buzon') || l.url.includes('/privado'))) {
            return false;
          }
          return true;
        }).map(l => ({
          ...l,
          verificado: l.verificado ?? this.isVerified(l.url),
        }));

        links.push(...secondary);
      }

      // 3. Fallbacks si no quedaron enlaces
      if (!links.length) {
        if (item.fuente === 'sat') {
          links = [
            {
              tipo:       'dof',
              label:      'Ver en DOF',
              url:        'https://www.dof.gob.mx',
              verificado: true,
              es_publico: true,
              icono:      '📋',
            },
            {
              tipo:       'oficial',
              label:      'Ver en SHCP',
              url:        'https://www.gob.mx/hacienda',
              verificado: true,
              es_publico: true,
              icono:      '🏛️',
            },
            {
              tipo:       'pdf',
              label:      'Leyes Vigentes (Cámara)',
              url:        'https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf',
              verificado: true,
              es_publico: true,
              icono:      '📄',
            }
          ];
        } else {
          const baseUrl = this.getCanonical(item.fuente, 'inicio');
          const itemUrl = baseUrl || null;
          if (itemUrl) {
            links = [{
              tipo:       'oficial',
              label:      this._defaultLabel(item.fuente),
              url:        itemUrl,
              verificado: true,
              es_publico: true,
              icono:      '🏛️',
            }];
          }
        }
      }

      return links;
    },

    _defaultLabel(fuente) {
      const m = {
        dof: 'Ver en DOF', sat: 'Ver en SAT', shcp: 'Ver en SHCP',
        banxico: 'Ver en Banxico', sil: 'Ver en SIL',
        diputados: 'Gaceta Parlamentaria', senado: 'Ver en Senado',
        cnbv: 'Ver en CNBV', uif: 'Ver en UIF',
        imcp: 'Ver en IMCP', gnews: 'Google News',
        imss: 'IMSS Patrones', infonavit: 'Infonavit',
      };
      return m[fuente] || 'Ver fuente oficial';
    },
  };

  /* ════════════════════════════════════════════════════════
     ESTADO GLOBAL
     ════════════════════════════════════════════════════════ */

  const State = {
    raw:        null,   // Datos crudos de radar.json
    processed:  null,   // Todos los ítems procesados por el clasificador
    loading:    true,

    // Filtros activos
    vista:      'todo',           // todo | vigilancia | alertas | dof | legislativo | analisis | noticias | regulatorio | fuentes
    categoria:  'todas',          // todas | fiscal | contable | legal | legislativo | financiero | empresarial | cripto
    impacto:    'todos',          // todos | alto | medio | bajo
    soloMexico: false,
    minScore:   15,
    sortBy:     'fecha',          // fecha | score | impacto
    query:      '',
  };

  /* ════════════════════════════════════════════════════════
     CONFIGURACIÓN
     ════════════════════════════════════════════════════════ */

  const CONFIG = {
    dataUrl:         './data/radar.json',
    clasificadorUrl: './data/clasificador.json',
    animDelay:       70,
  };

  /* ════════════════════════════════════════════════════════
     TAXONOMÍA UI
     ════════════════════════════════════════════════════════ */

  const CAT_META = {
    fiscal:      { label: 'Fiscal',                 icono: '🏛️', color: '#60A5FA' },
    contable:    { label: 'Contable',               icono: '📊', color: '#34D399' },
    legal:       { label: 'Legal y regulatorio',    icono: '⚖️', color: '#A78BFA' },
    legislativo: { label: 'Legislativo',            icono: '🏛️', color: '#C4B5FD' },
    financiero:  { label: 'Financiero estratégico', icono: '📈', color: '#FACC15' },
    empresarial: { label: 'Empresarial',            icono: '🏢', color: '#FB923C' },
    cripto:      { label: 'Cripto y Fintech',       icono: '₿',  color: '#94A3B8' },
  };

  const IMPACTO_META = {
    alto:  { label: 'Alto',  color: '#FF4D6D', icon: '🔴' },
    medio: { label: 'Medio', color: '#FACC15', icon: '🟡' },
    bajo:  { label: 'Bajo',  color: '#22C55E', icon: '🟢' },
  };

  const SEV_CFG = {
    critica: { label: 'Crítica',  cls: 'badge-critica', pulse: true  },
    alta:    { label: 'Alta',     cls: 'badge-alta',    pulse: false },
    media:   { label: 'Media',    cls: 'badge-media',   pulse: false },
    baja:    { label: 'Baja',     cls: 'badge-baja',    pulse: false },
  };

  const ESTADO_CLS = {
    'en comision':  'estado-en-comision',
    'dictaminada':  'estado-dictaminada',
    'aprobada':     'estado-aprobada',
    'archivada':    'estado-archivada',
  };

  const SOURCE_LABELS = {
    dof: 'DOF', sat: 'SAT', shcp: 'SHCP', banxico: 'Banxico',
    sil: 'SIL', diputados: 'Diputados', senado: 'Senado',
    cnbv: 'CNBV', condusef: 'CONDUSEF', uif: 'UIF',
    imcp: 'IMCP', gnews: 'Google News', imss: 'IMSS',
  };

  /* ════════════════════════════════════════════════════════
     UTILIDADES
     ════════════════════════════════════════════════════════ */

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('es-MX', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }

  function relativeTime(iso) {
    const diff  = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days  = Math.floor(hours / 24);
    if (days > 30) return formatDate(iso);
    if (days > 0)  return `hace ${days} día${days > 1 ? 's' : ''}`;
    if (hours > 0) return `hace ${hours} h`;
    if (mins > 0)  return `hace ${mins} min`;
    return 'hace un momento';
  }

  function staggerFadeUp(els, baseDelay = 0) {
    els.forEach((el, i) => {
      el.classList.add('fade-up');
      setTimeout(() => requestAnimationFrame(() => el.classList.add('visible')),
        baseDelay + i * CONFIG.animDelay);
    });
  }

  function animateCounter(el, target, duration = 900) {
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      el.textContent = Math.round((1 - Math.pow(1 - t, 3)) * target);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function emptyState(msg) {
    return `<div class="empty-state">
      <div class="empty-icon">🔍</div>
      <p>${esc(msg)}</p>
    </div>`;
  }

  function el(id) { return document.getElementById(id); }

  /* ════════════════════════════════════════════════════════
     SCORE BAR & BADGES
     ════════════════════════════════════════════════════════ */

  function scoreBar(score) {
    const pct  = Math.min(100, score);
    const col  = score >= 70 ? '#FF4D6D' : score >= 45 ? '#FACC15' : '#22C55E';
    const lbl  = score >= 70 ? 'Alto' : score >= 45 ? 'Medio' : 'Bajo';
    return `
      <div class="score-bar-wrap" title="Score de relevancia: ${score}/100">
        <div class="score-bar">
          <div class="score-fill" style="width:${pct}%;background:${col};"></div>
        </div>
        <span class="score-num" style="color:${col};">${score}</span>
      </div>`;
  }

  function catPill(catId) {
    const m = CAT_META[catId] || CAT_META.fiscal;
    return `<span class="cat-pill" style="--cat-color:${m.color};">${m.icono} ${esc(m.label)}</span>`;
  }

  function impactBadge(impacto) {
    const m = IMPACTO_META[impacto] || IMPACTO_META.bajo;
    return `<span class="impact-badge impact-${esc(impacto)}">${m.icon} ${esc(m.label)}</span>`;
  }

  function mxFlag(isMx) {
    return isMx ? `<span class="mx-flag" title="Relevante para México">🇲🇽</span>` : '';
  }

  function keywordTags(kws = []) {
    if (!kws.length) return '';
    return `<div class="keyword-tags">${
      kws.slice(0, 3).map(k => `<span class="kw-tag">${esc(k)}</span>`).join('')
    }</div>`;
  }

  /** Renderiza insignias para live data, verificado y fuente oficial */
  function liveBadges(i) {
    let badges = '';
    if (i.is_live_data) {
      badges += `<span class="badge-live-data"><span class="pulse-dot"></span>LIVE DATA</span>`;
    }
    const score = i.trust_score !== undefined ? i.trust_score : UrlManager.getConfianza(i.fuente);
    if (score >= 90) {
      badges += `<span class="badge-official">🏛️ OFFICIAL SOURCE</span>`;
    }
    if (i.verified) {
      badges += `<span class="badge-verified">✓ VERIFIED</span>`;
    }
    return badges;
  }

  /** Normaliza la estructura de los ítems de feeds en vivo */
  function normalizeLiveItem(item, defaultSource) {
    const title = item.title || item.titulo || "";
    const summary = item.summary || item.descripcion || item.description || "";
    const source = (item.source_type || item.fuente || defaultSource || "").toLowerCase();
    const date = item.published_at || item.fecha || new Date().toISOString();
    
    let severidad = 'media';
    if (item.impact === 'alto' || item.impacto === 'alto') severidad = 'alta';
    else if (item.impact === 'bajo' || item.impacto === 'bajo') severidad = 'baja';
    
    let links = item.links || [];
    if (item.pdf_url) {
      const hasPdf = links.some(l => l.tipo === 'pdf' || l.url === item.pdf_url);
      if (!hasPdf) {
        links.push({
          tipo: 'pdf',
          label: 'Ver PDF',
          url: item.pdf_url,
          verificado: true,
          es_publico: true,
          icono: '📄'
        });
      }
    }
    
    if (item.source_url) {
      const hasSourceUrl = links.some(l => l.url === item.source_url);
      if (!hasSourceUrl) {
        let label = 'Ver fuente oficial';
        let tipo = 'oficial';
        let icono = '🏛️';
        if (source === 'dof') { label = 'Ver en DOF'; tipo = 'dof'; icono = '📋'; }
        else if (source === 'sil') { label = 'Ver en SIL'; tipo = 'sil'; icono = '⚖️'; }
        else if (source === 'senado') { label = 'Ver en Senado (SIL)'; tipo = 'senado'; icono = '🏛️'; }
        else if (source === 'banxico') { label = 'Ver en Banxico'; tipo = 'banxico'; icono = '📈'; }
        
        links.unshift({
          tipo: tipo,
          label: label,
          url: item.source_url,
          verificado: item.verified !== undefined ? item.verified : true,
          es_publico: true,
          icono: icono
        });
      }
    }

    return {
      id: item.id || `${source.toUpperCase()}-${Math.random().toString(36).substr(2, 9)}`,
      titulo: title,
      descripcion: summary,
      fuente: source,
      fecha: date,
      severidad: severidad,
      categoria_manual: item.category || item.categoria_manual || null,
      mexico_relevante: true,
      tags: item.keywords || item.tags || [],
      source_url: item.source_url || null,
      source_type: source,
      source_title: item.source_title || title,
      published_at: date,
      verified: item.verified !== undefined ? item.verified : true,
      trust_score: item.trust_score !== undefined ? item.trust_score : 100,
      tipo_contenido: 'documento_oficial',
      links: links,
      camara: item.camara || null,
      estado: item.estado || null,
      etapa: item.etapa || null,
      relevancia: item.relevancia || null,
      is_live_data: true
    };
  }

  /* ════════════════════════════════════════════════════════
     SISTEMA DE ENLACES VERIFICADOS
     ════════════════════════════════════════════════════════ */

  /**
   * Renderiza botones de links verificados para un ítem.
   * @param {Array} links - Array de objetos link del JSON
   */
  function renderLinks(links = []) {
    if (!links.length) return '';
    const btns = links.map(l => linkBtn(l)).filter(Boolean).join('');
    return btns ? `<div class="links-row">${btns}</div>` : '';
  }

  /** Genera un botón de link tipificado y verificado */
  function linkBtn(l) {
    if (!l?.url || l.url === '#') return '';
    const typeClass   = `link-${l.tipo || 'oficial'}`;
    const verifiedCls = l.verificado ? 'link-verified' : 'link-unverified';
    const icon = l.icono || {
      oficial:     '🏛️', dof:        '📋', rmf:         '📜',
      declaracion: '📝', pdf:        '📄', gaceta:      '📑',
      iniciativa:  '⚖️', sil:        '⚖️', senado:      '🏛️',
      nif:         '📊', regulatorio: '🔒', noticias:    '📰',
    }[l.tipo] || '🔗';
    const checkMark = l.verificado
      ? `<span class="link-check" title="URL verificada en catálogo oficial">✓</span>`
      : '';
    return `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"
       class="link-btn ${typeClass} ${verifiedCls}"
       title="${esc(l.url)}">
      ${icon} <span>${esc(l.label || 'Ver')}</span>${checkMark}
    </a>`;
  }

  /** Badge de confianza de fuente con score del propio ítem o del catálogo */
  function sourceConfianzaBadge(fuente, item = null) {
    const score = (item && item.trust_score !== undefined) ? item.trust_score : UrlManager.getConfianza(fuente);
    if (score >= 93) return `<span class="src-confianza src-conf-alta" title="Confianza ${score}/100 — Documento oficial primario verificado">⭐ Fuente oficial</span>`;
    if (score >= 75) return `<span class="src-confianza src-conf-media" title="Confianza ${score}/100 — Documento verificado secundario">✓ Verificada</span>`;
    return `<span class="src-confianza src-conf-baja" title="Confianza ${score}/100 — Información de contexto o secundaria">○ Contexto</span>`;
  }

  /** Distintivo de tipo de contenido para el modelo SOURCE-FIRST */
  function contentTypeBadge(tipoContenido, sinDocumento = false) {
    if (sinDocumento) {
      return `<span class="content-type-badge type-sin-documento" title="Sin documento oficial de respaldo — Solo informativo">⚠️ Sin doc. oficial</span>`;
    }
    if (tipoContenido === 'documento_oficial') {
      return `<span class="content-type-badge type-documento-oficial" title="Contenido enlazado directamente a documento oficial verificado">🏛️ Doc. Oficial</span>`;
    }
    if (tipoContenido === 'analisis_numera') {
      return `<span class="content-type-badge type-analisis-numera" title="Comentario y análisis estratégico de expertos NUMERA">📊 Análisis NUMERA</span>`;
    }
    if (tipoContenido === 'resumen_ia') {
      return `<span class="content-type-badge type-resumen-ia" title="Resumen automático generado por Inteligencia Artificial de fuentes públicas">🤖 Resumen IA</span>`;
    }
    return '';
  }

  /* ════════════════════════════════════════════════════════
     FETCH & PROCESS
     ════════════════════════════════════════════════════════ */

  async function fetchData() {
    const paths = {
      historical: CONFIG.dataUrl,
      dof: './data/live/dof_feed.json',
      sil: './data/live/sil_feed.json',
      senado: './data/live/senado_feed.json',
      banxico: './data/live/banxico_feed.json'
    };

    const results = await Promise.allSettled(
      Object.entries(paths).map(async ([key, path]) => {
        const res = await fetch(path, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
        return { key, data: await res.json() };
      })
    );

    const loaded = {
      historical: null,
      dof: [],
      sil: [],
      senado: [],
      banxico: []
    };

    results.forEach(r => {
      if (r.status === 'fulfilled') {
        loaded[r.value.key] = r.value.data;
      } else {
        console.warn('[FetchData] Failed to load resource:', r.reason);
      }
    });

    if (!loaded.historical) {
      console.error('[FetchData] Error fatal: No se pudo cargar radar.json');
      return null;
    }

    return {
      ...loaded.historical,
      meta: loaded.historical.meta,
      live: {
        dof: loaded.dof || [],
        sil: loaded.sil || [],
        senado: loaded.senado || [],
        banxico: loaded.banxico || []
      }
    };
  }

  /**
   * Procesa todos los arrays de datos y los consolida en State.processed.
   * Las secciones de fuente fija (dof, legislativo) tienen su propio array.
   * 'todos' agrega todos para filtros cruzados.
   */
  function processAll(raw) {
    // 1. Cargar y normalizar ítems en vivo
    const liveRaw = raw.live || {};
    const liveDofMapped = (liveRaw.dof || []).map(item => normalizeLiveItem(item, 'dof'));
    const liveSilMapped = (liveRaw.sil || []).map(item => normalizeLiveItem(item, 'sil'));
    const liveSenadoMapped = (liveRaw.senado || []).map(item => normalizeLiveItem(item, 'senado'));
    const liveBanxicoMapped = (liveRaw.banxico || []).map(item => normalizeLiveItem(item, 'banxico'));

    // 2. Procesar mediante ClasificadorFiscal
    const processedDof = ClasificadorFiscal.processArray(liveDofMapped);
    const processedSil = ClasificadorFiscal.processArray(liveSilMapped);
    const processedSenado = ClasificadorFiscal.processArray(liveSenadoMapped);
    const processedBanxico = ClasificadorFiscal.processArray(liveBanxicoMapped);

    // 3. Distribuir ítems procesados
    const liveDofVigilancia = processedDof.filter(i => i._impacto === 'alto' || i.severidad === 'alta');
    const liveLegislativo = [...processedSil, ...processedSenado];

    // 4. Consolidar secciones combinando histórico y en vivo
    const finalVigilancia  = ClasificadorFiscal.processArray([...(raw.vigilancia || []), ...liveDofVigilancia]);
    const finalAlertas     = ClasificadorFiscal.processArray(raw.alertas || []);
    const finalDof         = ClasificadorFiscal.processArray([...(raw.dof || []), ...processedDof]);
    const finalLegislativo = ClasificadorFiscal.processArray([...(raw.legislativo || []), ...liveLegislativo]);
    const finalRegulatorio = ClasificadorFiscal.processArray([...(raw.regulatorio || []), ...processedBanxico]);
    const finalNoticias    = ClasificadorFiscal.processArray([...(raw.noticias || []), ...processedBanxico]);

    // Todos los ítems juntos para filtros transversales
    const todos = ClasificadorFiscal.dedup([
      ...finalVigilancia, ...finalAlertas, ...finalDof,
      ...finalLegislativo, ...finalRegulatorio, ...finalNoticias,
    ]);

    return { 
      vigilancia: finalVigilancia, 
      alertas: finalAlertas, 
      dof: finalDof, 
      legislativo: finalLegislativo, 
      regulatorio: finalRegulatorio, 
      noticias: finalNoticias, 
      todos 
    };
  }

  /* ════════════════════════════════════════════════════════
     PIPELINE DE FILTROS
     ════════════════════════════════════════════════════════ */

  function applyFilters(items) {
    let list = [...items];

    // Búsqueda textual
    if (State.query) {
      const q = State.query.toLowerCase();
      list = list.filter(it =>
        ClasificadorFiscal.getText(it).includes(q)
      );
    }

    // Filtro por categoría taxonómica
    if (State.categoria !== 'todas') {
      list = list.filter(it => it._categoria === State.categoria);
    }

    // Filtro por impacto
    if (State.impacto !== 'todos') {
      list = list.filter(it => it._impacto === State.impacto);
    }

    // Solo México
    if (State.soloMexico) {
      list = list.filter(it => it._mexico);
    }

    // Score mínimo
    list = list.filter(it => it._score >= State.minScore);

    // Ordenamiento
    list.sort((a, b) => {
      if (State.sortBy === 'score')  return b._score - a._score;
      if (State.sortBy === 'impacto') {
        const ord = { alto: 0, medio: 1, bajo: 2 };
        return (ord[a._impacto] ?? 2) - (ord[b._impacto] ?? 2);
      }
      return new Date(b.fecha) - new Date(a.fecha); // 'fecha' default
    });

    return list;
  }

  /* ════════════════════════════════════════════════════════
     KPI BAR — 6 bloques
     ════════════════════════════════════════════════════════ */

  function renderKPIs(proc) {
    const todos   = proc.todos;
    const altoImp = todos.filter(i => i._impacto === 'alto').length;
    const hoy     = proc.vigilancia.length;
    const ofic    = proc.dof.length;
    const legAct  = proc.legislativo.filter(l => l.estado !== 'Archivada').length;
    const avgScore = todos.length
      ? Math.round(todos.reduce((s, i) => s + i._score, 0) / todos.length)
      : 0;

    const kpis = [
      { id:'kpi-total',   cls:'kpi-alertas',  label:'ÍTEMS ACTIVOS',       value: todos.length,  sub:'en el Radar'            },
      { id:'kpi-alto',    cls:'kpi-dof',      label:'IMPACTO ALTO',         value: altoImp,        sub:'requieren atención'      },
      { id:'kpi-vig',     cls:'kpi-leg',      label:'VIGILANCIA HOY',       value: hoy,            sub:'alertas del día'         },
      { id:'kpi-ofic',    cls:'kpi-noticias', label:'PUBLICACIONES OFIC.',  value: ofic,           sub:'DOF y fuentes tier 1'   },
      { id:'kpi-leg',     cls:'kpi-alertas',  label:'INICIATIVAS ACTIVAS',  value: legAct,         sub:'en seguimiento'          },
      { id:'kpi-score',   cls:'kpi-dof',      label:'SCORE PROMEDIO',       value: avgScore,       sub:'relevancia del feed'     },
    ];

    const bar = el('kpi-bar');
    if (!bar) return;

    bar.innerHTML = kpis.map(k => `
      <div class="kpi-block ${k.cls} fade-up" id="${k.id}">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value" data-target="${k.value}">0</div>
        <div class="kpi-sub">${esc(k.sub)}</div>
      </div>
    `).join('');

    bar.querySelectorAll('.kpi-block').forEach((block, i) => {
      setTimeout(() => {
        requestAnimationFrame(() => block.classList.add('visible'));
        animateCounter(block.querySelector('.kpi-value'),
          parseInt(block.querySelector('.kpi-value').dataset.target, 10), 900);
      }, i * 130);
    });
  }

  /* ════════════════════════════════════════════════════════
     RENDER: VIGILANCIA FISCAL
     ════════════════════════════════════════════════════════ */

  function renderVigilancia(items) {
    const c = el('section-vigilancia');
    const filtered = applyFilters(items);
    updateCount('vigilancia', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('Sin alertas de vigilancia activas hoy.'); return; }

    c.innerHTML = `<div class="alerts-grid">
      ${filtered.map(i => vigilanciaCard(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.alert-card'));
  }

  function vigilanciaCard(i) {
    const sev   = SEV_CFG[i.severidad] || SEV_CFG.alta;
    const links = UrlManager.buildLinks(i);
    return `
      <div class="alert-card sev-${esc(i.severidad)} vigilancia-card fade-up">
        <div class="alert-top">
          <span class="alert-badge ${esc(sev.cls)}">${sev.pulse ? '<span class="pulse-dot"></span>' : ''}${esc(sev.label)}</span>
          ${impactBadge(i._impacto)}
          ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
          ${mxFlag(i._mexico)}
          ${liveBadges(i)}
        </div>
        ${scoreBar(i._score)}
        <h3>${esc(i.titulo)}</h3>
        <p>${esc(i.descripcion)}</p>
        ${keywordTags(i._keywords)}
        <div class="alert-footer">
          <span>📅 ${relativeTime(i.fecha)}</span>
          ${catPill(i._categoria)}
          ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        ${renderLinks(links)}
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: ALERTAS CRÍTICAS
     ════════════════════════════════════════════════════════ */

  function renderAlertas(items) {
    const c = el('section-alertas');
    const filtered = applyFilters(items);
    updateCount('alertas', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('No hay alertas que coincidan con los filtros activos.'); return; }

    c.innerHTML = `<div class="alerts-grid">
      ${filtered.map(i => alertCard(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.alert-card'));
  }

  function alertCard(i) {
    const sev   = SEV_CFG[i.severidad] || SEV_CFG.baja;
    const links = UrlManager.buildLinks(i);
    return `
      <div class="alert-card sev-${esc(i.severidad)} fade-up">
        <div class="alert-top">
          <span class="alert-badge ${esc(sev.cls)}">${sev.pulse ? '<span class="pulse-dot"></span>' : ''}${esc(sev.label)}</span>
          ${impactBadge(i._impacto)}
          ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
          ${mxFlag(i._mexico)}
          ${liveBadges(i)}
        </div>
        ${scoreBar(i._score)}
        <h3>${esc(i.titulo)}</h3>
        <p>${esc(i.descripcion)}</p>
        ${keywordTags(i._keywords)}
        <div class="alert-footer">
          <span>📅 ${relativeTime(i.fecha)}</span>
          ${catPill(i._categoria)}
          ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        ${renderLinks(links)}
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: PUBLICACIONES OFICIALES (DOF)
     ════════════════════════════════════════════════════════ */

  function renderDOF(items) {
    const c = el('section-dof');
    const filtered = applyFilters(items);
    updateCount('dof', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('No hay publicaciones oficiales que coincidan.'); return; }

    c.innerHTML = `<div class="dof-list">
      ${filtered.map(i => dofItem(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.dof-item'));
  }

  function dofItem(i) {
    const links = UrlManager.buildLinks(i);
    return `
      <div class="dof-item fade-up">
        <div class="dof-type-col">
          <span class="dof-type-badge">${esc(i.tipo || 'DOF')}</span>
          ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        <div class="dof-content">
          <div class="dof-meta-top">
            ${impactBadge(i._impacto)}
            ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
            ${catPill(i._categoria)}
            ${mxFlag(i._mexico)}
            ${liveBadges(i)}
          </div>
          <h4>${esc(i.titulo)}</h4>
          <div class="dof-meta">
            <span>📄 ${esc(i.seccion || '')}</span>
            <span>📅 ${formatDate(i.fecha)}</span>
          </div>
          ${scoreBar(i._score)}
          ${keywordTags(i._keywords)}
          ${renderLinks(links)}
        </div>
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: SEGUIMIENTO LEGISLATIVO
     ════════════════════════════════════════════════════════ */

  function renderLegislativo(items) {
    const c = el('section-legislativo');
    const filtered = applyFilters(items);
    updateCount('legislativo', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('No hay iniciativas que coincidan.'); return; }

    c.innerHTML = `<div class="leg-grid">
      ${filtered.map(i => legCard(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.leg-card'));
  }

  function legCard(i) {
    const estadoCls = ESTADO_CLS[i.estado?.toLowerCase()] || 'estado-en-comision';
    const relCls    = `rel-${i.relevancia}`;
    const links     = UrlManager.buildLinks(i);
    return `
      <div class="leg-card fade-up">
        <div class="leg-top">
          <span class="leg-camara">⚖ ${esc(i.camara)}</span>
          <span class="leg-estado ${esc(estadoCls)}">${esc(i.estado)}</span>
          ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
          ${mxFlag(i._mexico)}
          ${liveBadges(i)}
        </div>
        ${scoreBar(i._score)}
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          ${impactBadge(i._impacto)} ${catPill(i._categoria)} ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        <h4>${esc(i.titulo)}</h4>
        <div class="leg-etapa">${esc(i.etapa)}</div>
        ${keywordTags(i._keywords)}
        <div class="leg-footer">
          <span>📅 ${formatDate(i.fecha)}</span>
          <span class="leg-relevancia ${esc(relCls)}">${esc(i.relevancia)}</span>
        </div>
        ${renderLinks(links)}
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: ANÁLISIS ESTRATÉGICO
     ════════════════════════════════════════════════════════ */

  function renderAnalisis(todosItems) {
    const c = el('section-analisis');
    // Toma ítems de cat financiero o empresarial de todos los arrays
    const base     = todosItems.filter(i => ['financiero','empresarial'].includes(i._categoria));
    const filtered = applyFilters(base);
    updateCount('analisis', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('Sin análisis estratégico disponible.'); return; }

    c.innerHTML = `<div class="news-grid">
      ${filtered.map(i => analisisCard(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.news-card'));
  }

  function analisisCard(i) {
    const srcLabel = SOURCE_LABELS[i.fuente] || esc(i.fuente || '');
    const links    = UrlManager.buildLinks(i);
    return `
      <div class="news-card fade-up">
        <div class="news-top">
          <span class="news-source-pill src-${esc(i.fuente)}">${esc(srcLabel)}</span>
          ${catPill(i._categoria)}
          ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
          ${mxFlag(i._mexico)}
          ${liveBadges(i)}
        </div>
        ${scoreBar(i._score)}
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          ${impactBadge(i._impacto)} ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        <h4>${esc(i.titulo)}</h4>
        <p class="news-summary">${esc(i.descripcion || i.resumen || '')}</p>
        ${keywordTags(i._keywords)}
        <div class="news-footer">
          <span>📅 ${relativeTime(i.fecha)}</span>
        </div>
        ${renderLinks(links)}
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: NOTICIAS ESTRATÉGICAS
     ════════════════════════════════════════════════════════ */

  function renderNoticias(items) {
    const c = el('section-noticias');
    const filtered = applyFilters(items);
    updateCount('noticias', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('No hay noticias estratégicas que coincidan.'); return; }

    c.innerHTML = `<div class="news-grid">
      ${filtered.map(i => newsCard(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.news-card'));
  }

  function newsCard(i) {
    const srcLabel = SOURCE_LABELS[i.fuente] || esc(i.fuente || '');
    const links    = UrlManager.buildLinks(i);
    return `
      <div class="news-card src-${esc(i.fuente)} fade-up">
        <div class="news-top">
          <span class="news-source-pill">${esc(srcLabel)}</span>
          ${catPill(i._categoria)}
          ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
          ${mxFlag(i._mexico)}
          ${liveBadges(i)}
        </div>
        ${scoreBar(i._score)}
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          ${impactBadge(i._impacto)} ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        <h4>${esc(i.titulo)}</h4>
        <p class="news-summary">${esc(i.resumen || i.descripcion || '')}</p>
        ${keywordTags(i._keywords)}
        <div class="news-footer">
          <span>📅 ${relativeTime(i.fecha)}</span>
        </div>
        ${renderLinks(links)}
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: CAMBIOS REGULATORIOS
     ════════════════════════════════════════════════════════ */

  function renderRegulatorio(items) {
    const c = el('section-regulatorio');
    const filtered = applyFilters(items);
    updateCount('regulatorio', filtered.length);
    if (!filtered.length) { c.innerHTML = emptyState('No hay cambios regulatorios recientes.'); return; }

    c.innerHTML = `<div class="dof-list">
      ${filtered.map(i => regulatorioItem(i)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.dof-item'));
  }

  function regulatorioItem(i) {
    const srcLabel = SOURCE_LABELS[i.fuente] || esc(i.fuente || '');
    const links    = UrlManager.buildLinks(i);
    return `
      <div class="dof-item fade-up">
        <div class="dof-type-col">
          <span class="dof-type-badge" style="background:rgba(167,139,250,.14);color:#A78BFA;border-color:rgba(167,139,250,.3);">
            ${esc(i.tipo || 'Regulatorio')}
          </span>
          ${sourceConfianzaBadge(i.fuente, i)}
        </div>
        <div class="dof-content">
          <div class="dof-meta-top">
            ${impactBadge(i._impacto)}
            ${contentTypeBadge(i.tipo_contenido, i.sin_documento_oficial)}
            ${catPill(i._categoria)}
            ${mxFlag(i._mexico)}
            ${liveBadges(i)}
          </div>
          <h4>${esc(i.titulo)}</h4>
          <p style="font-size:.83rem;color:rgba(255,255,255,.7);line-height:1.65;margin:6px 0 8px;">${esc(i.descripcion || '')}</p>
          <div class="dof-meta">
            <span>🏛️ ${esc(srcLabel)}</span>
            <span>📅 ${formatDate(i.fecha)}</span>
          </div>
          ${scoreBar(i._score)}
          ${keywordTags(i._keywords)}
          ${renderLinks(links)}
        </div>
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER: ESTADO DE FUENTES
     ════════════════════════════════════════════════════════ */

  function renderFuentes(sources) {
    const c = el('section-fuentes');
    if (!c) return;
    c.innerHTML = `<div class="sources-grid">
      ${sources.map(s => sourceCard(s)).join('')}
    </div>`;
    staggerFadeUp(c.querySelectorAll('.source-card'));
  }

  function sourceCard(s) {
    const cls = s.activa ? 'status-activa' : 'status-inactiva';
    const txt = s.activa ? 'Activa' : 'Inactiva';
    return `
      <div class="source-card fade-up">
        <div class="source-card-top">
          <span class="source-status-dot ${cls}"></span>
          <span class="source-dot ${esc(s.id)}"></span>
          <span class="source-card-name">${esc(s.nombre)}</span>
        </div>
        <div class="source-card-url">${esc(s.url)}</div>
        <div class="source-card-last">Estado: <strong>${txt}</strong></div>
      </div>`;
  }

  /* ════════════════════════════════════════════════════════
     HELPERS DE RENDER
     ════════════════════════════════════════════════════════ */

  function updateCount(id, n) {
    const e = el(`count-${id}`);
    if (e) e.textContent = n;
    const es = el(`count-side-${id}`);
    if (es) es.textContent = n;
  }

  function updateSidebarCounts(proc) {
    const map = {
      'count-side-todo':        proc.todos.length,
      'count-side-vigilancia':  proc.vigilancia.length,
      'count-side-alertas':     proc.alertas.length,
      'count-side-dof':         proc.dof.length,
      'count-side-legislativo': proc.legislativo.length,
      'count-side-noticias':    proc.noticias.length,
      'count-side-regulatorio': proc.regulatorio.length,
    };
    Object.entries(map).forEach(([id, val]) => {
      const e = el(id);
      if (e) e.textContent = val;
    });
  }

  function updateScoreStats(proc) {
    const e = el('score-stats');
    if (!e || !proc.todos.length) return;
    const avg = Math.round(proc.todos.reduce((s, i) => s + i._score, 0) / proc.todos.length);
    const max = Math.max(...proc.todos.map(i => i._score));
    e.textContent = `Score: prom. ${avg} / max. ${max}`;
  }

  function setLastUpdated(iso) {
    const e = el('last-updated');
    if (e) e.innerHTML = `Actualizado: <strong>${relativeTime(iso)}</strong>`;
  }

  /* ════════════════════════════════════════════════════════
     RENDER COMPLETO
     ════════════════════════════════════════════════════════ */

  const VISTAS_MAP = {
    'dash-vigilancia':  'vigilancia',
    'dash-alertas':     'alertas',
    'dash-dof':         'dof',
    'dash-legislativo': 'legislativo',
    'dash-analisis':    'analisis',
    'dash-noticias':    'noticias',
    'dash-regulatorio': 'regulatorio',
    'dash-fuentes':     'fuentes',
  };

  function applyVistaVisibility() {
    const vistasToShow = State.vista === 'todo'
      ? Object.keys(VISTAS_MAP)
      : [`dash-${State.vista}`];

    Object.keys(VISTAS_MAP).forEach(id => {
      const e = el(id);
      if (e) e.style.display = vistasToShow.includes(id) ? '' : 'none';
    });
  }

  function renderAll(proc) {
    renderKPIs(proc);
    renderVigilancia(proc.vigilancia);
    renderAlertas(proc.alertas);
    renderDOF(proc.dof);
    renderLegislativo(proc.legislativo);
    renderAnalisis(proc.todos);
    renderNoticias(proc.noticias);
    renderRegulatorio(proc.regulatorio);
    renderFuentes(State.raw.meta.sources);
    updateSidebarCounts(proc);
    updateScoreStats(proc);
    setLastUpdated(State.raw.meta.updated);
    applyVistaVisibility();
  }

  /* ════════════════════════════════════════════════════════
     SKELETON LOADERS
     ════════════════════════════════════════════════════════ */

  function showSkeletons() {
    const gridSecs = ['section-vigilancia','section-alertas','section-analisis','section-noticias'];
    gridSecs.forEach(id => {
      const e = el(id);
      if (e) e.innerHTML = `<div class="alerts-grid">
        ${[1,2,3].map(() => '<div class="skeleton-card skeleton"></div>').join('')}
      </div>`;
    });
    ['section-dof','section-regulatorio'].forEach(id => {
      const e = el(id);
      if (e) e.innerHTML = `<div class="dof-list">
        ${[1,2,3].map(() => '<div class="skeleton-card skeleton" style="height:80px;border-radius:16px;"></div>').join('')}
      </div>`;
    });
    ['section-legislativo'].forEach(id => {
      const e = el(id);
      if (e) e.innerHTML = `<div class="leg-grid">
        ${[1,2,3].map(() => '<div class="skeleton-card skeleton"></div>').join('')}
      </div>`;
    });
  }

  /* ════════════════════════════════════════════════════════
     CONTROLES DE FILTRADO
     ════════════════════════════════════════════════════════ */

  function initFilters() {
    // ── Filtros de VISTA (sidebar secciones) ──
    document.querySelectorAll('[data-filter-vista]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-filter-vista]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        State.vista = btn.dataset.filterVista;
        if (State.processed) renderAll(State.processed);
      });
    });

    // ── Filtros de CATEGORÍA taxonómica ──
    document.querySelectorAll('[data-filter-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-filter-cat]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        State.categoria = btn.dataset.filterCat;
        if (State.processed) renderAll(State.processed);
      });
    });

    // ── Filtro por IMPACTO ──
    document.querySelectorAll('[data-filter-impacto]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-filter-impacto]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        State.impacto = btn.dataset.filterImpacto;
        if (State.processed) renderAll(State.processed);
      });
    });

    // ── Toggle SOLO MÉXICO ──
    const mxToggle = el('toggle-mx');
    if (mxToggle) {
      mxToggle.addEventListener('change', () => {
        State.soloMexico = mxToggle.checked;
        if (State.processed) renderAll(State.processed);
      });
    }

    // ── Score SLIDER ──
    const slider = el('score-slider');
    const sliderVal = el('score-slider-val');
    if (slider) {
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        State.minScore = v;
        if (sliderVal) sliderVal.textContent = v;
        if (State.processed) renderAll(State.processed);
      });
    }

    // ── SORT BY ──
    const sortSel = el('sort-select');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        State.sortBy = sortSel.value;
        if (State.processed) renderAll(State.processed);
      });
    }
  }

  /* ════════════════════════════════════════════════════════
     BÚSQUEDA GLOBAL
     ════════════════════════════════════════════════════════ */

  function initSearch() {
    const input = el('search-input');
    if (!input) return;
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        State.query = input.value.trim();
        if (State.processed) renderAll(State.processed);
      }, 280);
    });
  }

  /* ════════════════════════════════════════════════════════
     REFRESH
     ════════════════════════════════════════════════════════ */

  function initRefresh() {
    const btn = el('btn-refresh');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '↻ Actualizando…';
      const raw = await fetchData();
      if (raw) {
        State.raw       = raw;
        State.processed = processAll(raw);
        renderAll(State.processed);
      }
      btn.disabled = false;
      btn.innerHTML = '↻ Actualizar';
    });
  }

  /* ════════════════════════════════════════════════════════
     INIT
     ════════════════════════════════════════════════════════ */

  async function init() {
    // 1. Cargar catálogo de URLs canónicas verificadas
    await UrlManager.load();
    // 2. Cargar reglas de clasificación semántica
    await ClasificadorFiscal.loadRules();

    initFilters();
    initSearch();
    initRefresh();
    showSkeletons();

    const raw = await fetchData();
    if (!raw) {
      ['section-vigilancia','section-alertas','section-dof','section-legislativo',
       'section-analisis','section-noticias','section-regulatorio'].forEach(id => {
        const e = el(id);
        if (e) e.innerHTML = emptyState('No se pudieron cargar los datos. Verifica la conexión.');
      });
      return;
    }

    State.raw       = raw;
    State.processed = processAll(raw);
    State.loading   = false;

    // Log de diagnóstico en consola
    console.group('[RadarFiscal v2] Pipeline de clasificación');
    console.log(`Ítems procesados: ${State.processed.todos.length}`);
    console.log(`Score promedio: ${Math.round(State.processed.todos.reduce((s,i)=>s+i._score,0)/State.processed.todos.length)}`);
    console.log('Por impacto:', {
      alto:  State.processed.todos.filter(i=>i._impacto==='alto').length,
      medio: State.processed.todos.filter(i=>i._impacto==='medio').length,
      bajo:  State.processed.todos.filter(i=>i._impacto==='bajo').length,
    });
    console.log('Por categoría:', Object.fromEntries(
      Object.keys(CAT_META).map(c => [c, State.processed.todos.filter(i=>i._categoria===c).length])
    ));
    console.groupEnd();

    renderAll(State.processed);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
