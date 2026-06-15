#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pipeline Documental del Diario Oficial de la Federación (DOF)
Arquitectura SOURCE-FIRST para el Radar Fiscal Inteligente NUMERA.
"""

import os
import sys
import re
import json
import ssl
import html
import argparse
import urllib.request
from datetime import datetime, timezone, timedelta

# Configuración básica de directorios
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLASIFICADOR_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'clasificador.json')
OUTPUT_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'live', 'dof_feed.json')

def log(level, message):
    print(f"[{level}] [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}")

def clean_html(text):
    """Limpia etiquetas HTML, decodifica entidades y normaliza espacios."""
    if not text:
        return ""
    # Remover bloques script y style
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Limpiar etiquetas HTML
    text = re.sub(r"<[^>]+>", " ", text)
    # Decodificar entidades HTML
    text = html.unescape(text)
    # Colapsar espacios
    text = " ".join(text.split())
    return text

def parse_arguments():
    parser = argparse.ArgumentParser(description="Scraper oficial de publicaciones del DOF para NUMERA.")
    parser.add_argument(
        '--date', 
        type=str, 
        default=None, 
        help="Fecha a consultar en formato YYYY-MM-DD (ej: 2026-05-26). Por defecto consulta el día de hoy."
    )
    parser.add_argument(
        '--output', 
        type=str, 
        default=OUTPUT_PATH, 
        help="Ruta de destino del archivo JSON generado."
    )
    return parser.parse_args()

class DOFScraper:
    def __init__(self, target_date_str=None):
        self.ssl_context = ssl._create_unverified_context()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }
        
        # Determinar fecha objetivo
        if target_date_str:
            self.target_date = datetime.strptime(target_date_str, "%Y-%m-%d")
        else:
            # Horario local México/Centro
            tz_mx = timezone(timedelta(hours=-6))
            self.target_date = datetime.now(tz_mx)
            
        self.date_dof_format = self.target_date.strftime("%d/%m/%Y")
        
        # Cargar clasificador.json
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
            
    def fetch_url(self, url):
        req = urllib.request.Request(url, headers=self.headers)
        try:
            resp = urllib.request.urlopen(req, context=self.ssl_context, timeout=15)
            raw = resp.read()
            charset = resp.headers.get_content_charset() or 'ISO-8859-1'
            return raw.decode(charset, errors='ignore')
        except Exception as e:
            log("WARNING", f"Error al descargar URL {url}: {e}")
            return None

    def scrape_dof_index(self):
        """Descarga el índice del DOF del día objetivo y extrae notas agrupadas por dependencia."""
        # URL diaria del DOF
        url = f"https://www.dof.gob.mx/index.php?year={self.target_date.year}&month={self.target_date.month:02d}&day={self.target_date.day:02d}"
        log("INFO", f"Consultando índice diario DOF en: {url}")
        
        html_content = self.fetch_url(url)
        if not html_content:
            log("ERROR", "No se pudo recuperar el índice del DOF.")
            return []
            
        # Encontrar las dependencias (subtitle_azul) y las notas asociadas
        # Buscamos dependencias utilizando la clase subtitle_azul
        sections = re.split(r'class="subtitle_azul"', html_content)
        
        # El primer bloque contiene cabeceras generales anteriores al primer subtitle_azul, lo ignoramos
        if len(sections) <= 1:
            log("WARNING", "No se encontraron secciones 'subtitle_azul' en el HTML. Intentando alternativa...")
            return []
            
        publications = []
        
        for section in sections[1:]:
            # Extraer el nombre de la dependencia/emisor
            header_match = re.match(r'[^>]*>(.*?)</td>', section, re.DOTALL)
            if not header_match:
                continue
            emisor = clean_html(header_match.group(1))
            
            # Filtro básico: saltar secciones de convocatorias y avisos menores en bloque
            if any(term in emisor.lower() for term in ["convocatoria", "avisos judiciales", "licitación"]):
                continue
                
            # Buscar todos los enlaces a nota_detalle.php dentro de esta sección
            # Formato: href="/nota_detalle.php?codigo=5788503&fecha=26/05/2026"
            # O con amp: href="/nota_detalle.php?codigo=5788503&amp;fecha=26/05/2026"
            note_matches = re.finditer(
                r'href=["\']([^"\']*nota_detalle\.php\?codigo=(\d+)[^"\']*)["\'][^>]*>(.*?)</a>',
                section,
                re.DOTALL | re.IGNORECASE
            )
            
            for match in note_matches:
                raw_url = html.unescape(match.group(1).strip())
                codigo = match.group(2).strip()
                raw_title = match.group(3)
                
                # Construir URLs absolutas
                if raw_url.startswith('/'):
                    raw_url = "https://www.dof.gob.mx" + raw_url
                elif not raw_url.startswith('http'):
                    raw_url = "https://www.dof.gob.mx/" + raw_url
                    
                title = clean_html(raw_title)
                
                # Limpiar títulos menores/repetidos o vacíos
                if not title or len(title) < 15:
                    continue
                    
                # Evitar edictos e instructivos del sector judicial
                if any(w in title.lower() for w in ["aviso judicial", "licitación pública", "edicto", "convocatoria para", "balances de sociedades"]):
                    continue
                    
                publications.append({
                    "id": f"DOF-{codigo}",
                    "codigo": codigo,
                    "title": title,
                    "emisor": emisor,
                    "published_at": self.target_date.strftime("%Y-%m-%dT00:00:00-06:00"),
                    "source_url": raw_url,
                    "pdf_url": f"https://www.dof.gob.mx/nota_detalle.php?codigo={codigo}&fecha={self.date_dof_format}&print=true",
                    "source_type": "DOF",
                    "verified": True,
                    "trust_score": 100
                })
                
        # Deduplicar por ID
        seen_ids = set()
        deduped = []
        for p in publications:
            if p["id"] not in seen_ids:
                seen_ids.add(p["id"])
                deduped.append(p)
                
        log("INFO", f"Se extrajeron {len(deduped)} publicaciones potenciales de dependencias relevantes.")
        return deduped

    def evaluate_item(self, item):
        """Recrea las reglas de ClasificadorFiscal para filtrar, puntuar y categorizar."""
        text_to_analyze = (item["title"] + " " + item["emisor"]).lower()
        
        # 1. Comprobar Blacklist
        blacklist = self.rules.get("blacklist", [])
        if any(term.lower() in text_to_analyze for term in blacklist):
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
            
            # Sumar al total general de keywords
            kw_score += cat_score
            
            # Encontrar categoría líder
            if cat_score > best_cat_score:
                best_cat_score = cat_score
                best_cat = cat_id
                
        # FILTRO DE RELEVANCIA: Si no tiene ninguna keyword relevante, se descarta (Reducción de Ruido)
        if not matched_keywords:
            return None
            
        # Asignar categoría líder, default a fiscal
        if not best_cat:
            best_cat = "fiscal"
            
        # 3. Calcular Bonuses
        # Source bonus para DOF
        source_bonus = self.rules.get("fuentes", {}).get("dof", {}).get("bonus", 20)
        
        # Recency bonus: asumimos 15 pts por ser del día evaluado (<= 0.5 días)
        recency_bonus = 15
        
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
            return None
            
        # Determinar impacto
        if score_value >= 70:
            impact_value = "alto"
        elif score_value >= 35:
            impact_value = "medio"
        else:
            impact_value = "bajo"
            
        # Enriquecer ítem con metadatos calculados
        item["category"] = best_cat
        item["impact"] = impact_value
        item["keywords"] = list(matched_keywords)
        item["score"] = score_value
        return item

    def fetch_summary(self, item):
        """Descarga el detalle de la nota y extrae el texto para generar el resumen breve."""
        log("INFO", f"Extrayendo resumen del cuerpo para: {item['id']}")
        detail_html = self.fetch_url(item["source_url"])
        if not detail_html:
            item["summary"] = item["title"]
            return item
            
        # Buscar el contenedor DivDetalleNota
        pos = detail_html.find("id='DivDetalleNota'")
        if pos == -1:
            pos = detail_html.find('id="DivDetalleNota"')
            
        if pos != -1:
            # Tomar un bloque considerable de texto (20k chars)
            chunk = detail_html[pos:pos+20000]
            clean_text = clean_html(chunk)
            
            # Limpiar rastro inicial del tag ID si queda
            if clean_text.startswith("id='DivDetalleNota'"):
                clean_text = clean_text[len("id='DivDetalleNota'"):]
            elif clean_text.startswith('id="DivDetalleNota"'):
                clean_text = clean_text[len('id="DivDetalleNota"'):]
            clean_text = re.sub(r'^[^>]*>', '', clean_text).strip()
            
            # Cortar a un máximo de 250 caracteres asegurando que no corte a mitad de palabra
            summary = clean_text[:250].strip()
            if len(clean_text) > 250:
                summary += "..."
                
            item["summary"] = summary
        else:
            log("WARNING", f"No se encontró DivDetalleNota para la nota {item['id']}")
            item["summary"] = item["title"]
            
        return item

    def run(self):
        log("INFO", f"Iniciando pipeline DOF para fecha: {self.target_date.strftime('%Y-%m-%d')} ({self.date_dof_format})")
        
        # 1. Recuperar notas de la portada
        raw_items = self.scrape_dof_index()
        if not raw_items:
            log("INFO", "No se encontraron publicaciones que procesar.")
            return []
            
        # 2. Filtrar, categorizar y evaluar por relevancia
        evaluated_items = []
        for raw_item in raw_items:
            item = self.evaluate_item(raw_item)
            if item:
                evaluated_items.append(item)
                
        log("INFO", f"Se filtraron {len(evaluated_items)} publicaciones relevantes.")
        
        # 3. Descargar resumen real del cuerpo de la nota
        final_items = []
        for item in evaluated_items:
            # Obtener resumen del cuerpo
            item_with_summary = self.fetch_summary(item)
            
            # Limpiar metadatos temporales de scraping del output final
            if "codigo" in item_with_summary:
                del item_with_summary["codigo"]
            if "emisor" in item_with_summary:
                del item_with_summary["emisor"]
                
            final_items.append(item_with_summary)
            
        return final_items

def save_feed(items, output_path):
    """Guarda los ítems en el feed de manera atómica."""
    try:
        # Asegurar directorio de destino
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        # Escribir con formato identado
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
            
        log("INFO", f"Feed guardado con éxito en: {output_path} ({len(items)} ítems)")
    except Exception as e:
        log("ERROR", f"No se pudo guardar el archivo de salida en {output_path}: {e}")

if __name__ == "__main__":
    args = parse_arguments()
    
    # Arrancar pipeline
    scraper = DOFScraper(args.date)
    items = scraper.run()
    
    # Guardar resultados
    save_feed(items, args.output)
