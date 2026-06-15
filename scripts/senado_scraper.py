#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pipeline Documental del Senado (vía SIL)
Arquitectura SOURCE-FIRST para el Radar Fiscal Inteligente NUMERA.
"""

import os
import sys
import re
import json
import ssl
import html
import time
import argparse
import urllib.request
from datetime import datetime, timezone, timedelta

# Configuración básica de directorios
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLASIFICADOR_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'clasificador.json')
OUTPUT_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'live', 'senado_feed.json')

def log(level, message):
    print(f"[{level}] [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}")

def clean_html(text, preserve_newlines=False):
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    lines = [line.strip() for line in text.split("\n")]
    lines = [l for l in lines if l]
    if preserve_newlines:
        return "\n".join(lines)
    else:
        return " ".join(lines)

def parse_arguments():
    parser = argparse.ArgumentParser(description="Scraper oficial de iniciativas del Senado para NUMERA.")
    parser.add_argument(
        '--limit', 
        type=int, 
        default=25,  # Buscamos un poco más para asegurarnos de encontrar iniciativas del Senado
        help="Límite de iniciativas de la búsqueda general a descargar. Por defecto 25."
    )
    parser.add_argument(
        '--output', 
        type=str, 
        default=OUTPUT_PATH, 
        help="Ruta de destino del archivo JSON generado."
    )
    return parser.parse_args()

class SenadoScraper:
    def __init__(self, limit=25):
        self.limit = limit
        self.ssl_context = ssl._create_unverified_context()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }
        self.rules = self.load_clasificador_rules()
        
    def load_clasificador_rules(self):
        try:
            with open(CLASIFICADOR_PATH, 'r', encoding='utf-8') as f:
                rules = json.load(f)
            log("INFO", f"Reglas de clasificación cargadas desde {CLASIFICADOR_PATH}")
            return rules
        except Exception as e:
            log("ERROR", f"No se pudo cargar clasificador.json: {e}")
            sys.exit(1)
            
    def fetch_url(self, url, retries=3, delay=2):
        for attempt in range(retries):
            req = urllib.request.Request(url, headers=self.headers)
            try:
                resp = urllib.request.urlopen(req, context=self.ssl_context, timeout=15)
                raw = resp.read()
                charset = resp.headers.get_content_charset() or 'utf-8'
                return raw.decode(charset, errors='ignore')
            except Exception as e:
                log("WARNING", f"Intento {attempt+1}/{retries} falló para {url}: {e}")
                if attempt < retries - 1:
                    time.sleep(delay)
        log("ERROR", f"No se pudo descargar URL después de {retries} intentos: {url}")
        return None

    def get_recency_bonus(self, date_str):
        try:
            pub_date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            tz_mx = timezone(timedelta(hours=-6))
            now = datetime.now(tz_mx)
            diff_days = (now - pub_date).total_seconds() / 86400.0
            
            if diff_days <= 0.5:
                return 15
            elif diff_days <= 1.0:
                return 13
            elif diff_days <= 3.0:
                return 10
            elif diff_days <= 7.0:
                return 7
            elif diff_days <= 14.0:
                return 4
            elif diff_days <= 30.0:
                return 1
            return 0
        except Exception:
            return 0

    def evaluate_item(self, item):
        """Aplica reglas de ClasificadorFiscal local para filtrar y categorizar el asunto."""
        text_to_analyze = (item["title"] + " " + item.get("summary", "")).lower()
        
        # 1. Comprobar Blacklist
        blacklist = self.rules.get("blacklist", [])
        if any(term.lower() in text_to_analyze for term in blacklist):
            log("INFO", f"Descartado por Blacklist: {item['id']}")
            return None
            
        # 2. Contar Keywords por Categoría
        categorias = self.rules.get("categorias", {})
        kw_score = 0
        matched_keywords = set()
        best_cat = None
        best_cat_score = 0
        
        for cat_id, cat_meta in categorias.items():
            cat_score = 0
            for kw in cat_meta.get("keywords", []):
                term = kw["term"].lower()
                if term in text_to_analyze:
                    cat_score += kw["weight"]
                    matched_keywords.add(kw["term"])
            
            kw_score += cat_score
            if cat_score > best_cat_score:
                best_cat_score = cat_score
                best_cat = cat_id
                
        # FILTRO DE RELEVANCIA: Si no tiene ninguna keyword relevante, se descarta
        if not matched_keywords:
            log("INFO", f"Descartado por falta de palabras clave: {item['id']}")
            return None
            
        if not best_cat:
            best_cat = "legislativo"  # Default
            
        # 3. Calcular Bonuses
        # Source bonus para senado (18 pts)
        source_bonus = self.rules.get("fuentes", {}).get("senado", {}).get("bonus", 18)
        
        # Recency bonus calculado dinámicamente
        recency_bonus = self.get_recency_bonus(item["published_at"])
        
        # Whitelist bonus
        whitelist_bonus = 0
        whitelist = self.rules.get("whitelist", [])
        if any(term.lower() in text_to_analyze for term in whitelist):
            whitelist_bonus = self.rules.get("config", {}).get("whitelist_bonus", 25)
            
        # Score final normalizado a 100
        score_value = min(100, kw_score + source_bonus + recency_bonus + whitelist_bonus)
        
        # Filtrar por score mínimo configurado
        min_score = self.rules.get("config", {}).get("score_minimo", 15)
        if score_value < min_score:
            log("INFO", f"Descartado por bajo score ({score_value} < {min_score}): {item['id']}")
            return None
            
        # Determinar impacto
        if score_value >= 70:
            impact_value = "alto"
        elif score_value >= 35:
            impact_value = "medio"
        else:
            impact_value = "bajo"
            
        # Enriquecer ítem
        item["category"] = best_cat
        item["impact"] = impact_value
        item["keywords"] = list(matched_keywords)
        item["score"] = score_value
        return item

    def scrape_sil_search(self):
        # Para senado podemos refinar la consulta agregando Origen=Senadores para ir directo si SIL lo soporta.
        # Pero consultar search_UTF con fiscal y filtrar en python es sumamente robusto.
        url = 'http://sil.gobernacion.gob.mx/Librerias/Search/search_UTF.php?Valor=fiscal'
        log("INFO", f"Consultando motor de búsqueda SIL para Senado en: {url}")
        
        html_content = self.fetch_url(url)
        if not html_content:
            return []
            
        matches = re.findall(r'href=["\']([^"\']*pp_ReporteSeguimiento\.php[^"\']*)["\']', html_content)
        
        links = []
        seen = set()
        for link in matches:
            link = html.unescape(link.strip())
            if link.startswith('/'):
                link = "http://sil.gobernacion.gob.mx" + link
            elif not link.startswith('http'):
                link = "http://sil.gobernacion.gob.mx/Librerias/" + link
                
            asunto_match = re.search(r'Asunto=(\d+)', link)
            if asunto_match:
                asunto_id = asunto_match.group(1)
                if asunto_id not in seen:
                    seen.add(asunto_id)
                    links.append((asunto_id, link))
                    
        log("INFO", f"Se encontraron {len(links)} asuntos únicos en el buscador.")
        return links[:self.limit]

    def parse_detail_page(self, asunto_id, url):
        log("INFO", f"Procesando detalle del asunto {asunto_id} en: {url}")
        html_content = self.fetch_url(url)
        if not html_content:
            return None
            
        tables = re.findall(r'<table[^>]*>.*?</table>', html_content, re.DOTALL)
        target_table = None
        for table in tables:
            if "Cámara Origen" in table or "C&aacute;mara Origen" in table:
                target_table = table
                break
                
        if not target_table:
            return None
            
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', target_table, re.DOTALL)
        metadata = {}
        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) == 2:
                key = clean_html(cells[0]).lower().strip()
                val_raw = cells[1].strip()
                metadata[key] = val_raw
                
        # 1. Cámara Origen (Filtro fundamental para el Senado)
        camara_raw = metadata.get("cámara origen") or ""
        camara = clean_html(camara_raw)
        
        # Filtro exclusivo de Senado
        if not ("senadores" in camara.lower() or "senado" in camara.lower()):
            log("INFO", f"Descartando Asunto {asunto_id}: Cámara de origen es '{camara}', no es Senado.")
            return None
            
        # 2. Título/Iniciativa
        title_raw = metadata.get("iniciativa") or metadata.get("asunto") or metadata.get("título")
        if not title_raw:
            return None
        title = clean_html(title_raw)
        
        # 3. Fecha de Presentación
        fecha_raw = metadata.get("fecha de presentación")
        if not fecha_raw:
            return None
        fecha_str = clean_html(fecha_raw)
        
        try:
            dt = datetime.strptime(fecha_str, "%d/%m/%Y")
            published_at = dt.strftime("%Y-%m-%dT00:00:00-06:00")
        except Exception:
            return None
            
        # 4. Aspectos Relevantes
        aspectos_raw = metadata.get("aspectos relevantes") or metadata.get("síntesis") or title_raw
        summary = clean_html(aspectos_raw)
        if len(summary) > 280:
            summary = summary[:277] + "..."
            
        # 5. Último Estatus
        estatus_raw = metadata.get("último estatus") or "Pendiente en comisión"
        estatus_lines = clean_html(estatus_raw, preserve_newlines=True).split("\n")
        estado = estatus_lines[0].strip() if estatus_lines else "Pendiente"
        
        # 6. Último Trámite
        tramite_raw = metadata.get("último trámite") or "Presentado en origen"
        etapa_lines = clean_html(tramite_raw, preserve_newlines=True).split("\n")
        etapa = etapa_lines[0].strip() if etapa_lines else "En comisiones"
        
        pdf_url = ""
        pdf_matches = re.findall(r'href=["\']([^"\']*\.pdf[^"\']*)["\']', html_content, re.IGNORECASE)
        if pdf_matches:
            pdf_url = html.unescape(pdf_matches[0].strip())
            if pdf_url.startswith('/'):
                pdf_url = "http://sil.gobernacion.gob.mx" + pdf_url
        
        links = [
            {
                "tipo": "senado",
                "label": "Ver en Senado (SIL)",
                "url": url,
                "verificado": True,
                "es_publico": True,
                "icono": "🏛️"
            }
        ]
        if pdf_url:
            links.append({
                "tipo": "pdf",
                "label": "Ver iniciativa (PDF)",
                "url": pdf_url,
                "verificado": True,
                "es_publico": True,
                "icono": "📄"
            })
            
        relevancia = "Media"
        if "hacienda" in summary.lower() or "impuesto" in summary.lower() or "fiscal" in summary.lower():
            relevancia = "Alta"
            
        item = {
            "id": f"SEN-{asunto_id}",  # Prefijo SEN para Senado
            "title": title,
            "published_at": published_at,
            "source_url": url,
            "source_type": "senado",
            "source_title": f"Asunto Legislativo Senado SIL-{asunto_id}",
            "verified": True,
            "trust_score": 100,
            "summary": summary,
            "camara": camara,
            "estado": estado,
            "etapa": etapa,
            "relevancia": relevancia,
            "links": links
        }
        
        if pdf_url:
            item["pdf_url"] = pdf_url
            
        return item

    def run(self):
        log("INFO", f"Iniciando scraper Senado. Límite de búsqueda: {self.limit}")
        asuntos = self.scrape_sil_search()
        if not asuntos:
            log("INFO", "No se encontraron asuntos en la búsqueda.")
            return []
            
        final_items = []
        for asunto_id, link in asuntos:
            raw_item = self.parse_detail_page(asunto_id, link)
            if not raw_item:
                continue
                
            evaluated = self.evaluate_item(raw_item)
            if evaluated:
                final_items.append(evaluated)
                
            time.sleep(1)
            
        return final_items

def save_feed(items, output_path):
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        log("INFO", f"Feed Senado guardado con éxito en: {output_path} ({len(items)} ítems)")
    except Exception as e:
        log("ERROR", f"No se pudo guardar el archivo de salida en {output_path}: {e}")

if __name__ == "__main__":
    args = parse_arguments()
    scraper = SenadoScraper(args.limit)
    items = scraper.run()
    save_feed(items, args.output)
