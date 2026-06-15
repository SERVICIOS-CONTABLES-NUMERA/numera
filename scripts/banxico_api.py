#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pipeline de Indicadores del Banco de México (Banxico)
Arquitectura SOURCE-FIRST para el Radar Fiscal Inteligente NUMERA.
"""

import os
import sys
import json
import ssl
import urllib.request
from datetime import datetime, timezone, timedelta

# Configuración básica de directorios
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLASIFICADOR_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'clasificador.json')
OUTPUT_PATH = os.path.join(BASE_DIR, 'radar', 'data', 'live', 'banxico_feed.json')

MONTHS_ES = {
    'ENE': 1, 'FEB': 2, 'MAR': 3, 'ABR': 4, 'MAY': 5, 'JUN': 6,
    'JUL': 7, 'AGO': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DIC': 12
}

def log(level, message):
    print(f"[{level}] [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}")

class BanxicoAPI:
    def __init__(self):
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
            
    def fetch_json(self, url):
        req = urllib.request.Request(url, headers=self.headers)
        try:
            resp = urllib.request.urlopen(req, context=self.ssl_context, timeout=10)
            return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            log("ERROR", f"Error al descargar o parsear {url}: {e}")
            return None

    def parse_banxico_date(self, date_str):
        # Formato esperado: "26 - MAY - 2026"
        try:
            parts = [p.strip() for p in date_str.split("-")]
            if len(parts) == 3:
                day = int(parts[0])
                month_name = parts[1].upper()
                year = int(parts[2])
                month = MONTHS_ES.get(month_name, 1)
                dt = datetime(year, month, day)
                return dt.strftime("%Y-%m-%dT00:00:00-06:00")
        except Exception as e:
            log("WARNING", f"No se pudo parsear la fecha '{date_str}': {e}")
        # Fallback a hoy
        return datetime.now().strftime("%Y-%m-%dT00:00:00-06:00")

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
        """Aplica reglas de ClasificadorFiscal para clasificar y puntuar el indicador."""
        text_to_analyze = (item["title"] + " " + item.get("summary", "")).lower()
        
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
            
            kw_score += cat_score
            if cat_score > best_cat_score:
                best_cat_score = cat_score
                best_cat = cat_id
                
        # Para Banxico, forzamos Financiero si tiene palabras de economía
        if not best_cat:
            best_cat = "financiero"
            
        # 3. Calcular Bonuses
        # Source bonus para banxico (19 pts)
        source_bonus = self.rules.get("fuentes", {}).get("banxico", {}).get("bonus", 19)
        
        # Recency bonus calculado dinámicamente
        recency_bonus = self.get_recency_bonus(item["published_at"])
        
        # Whitelist bonus
        whitelist_bonus = 0
        whitelist = self.rules.get("whitelist", [])
        if any(term.lower() in text_to_analyze for term in whitelist):
            whitelist_bonus = self.rules.get("config", {}).get("whitelist_bonus", 25)
            
        # Score final normalizado a 100
        score_value = min(100, kw_score + source_bonus + recency_bonus + whitelist_bonus)
        
        # Determinar impacto
        if score_value >= 70:
            impact_value = "alto"
        elif score_value >= 35:
            impact_value = "medio"
        else:
            impact_value = "bajo"
            
        item["category"] = best_cat
        item["impact"] = impact_value
        item["keywords"] = list(matched_keywords)
        item["score"] = score_value
        return item

    def run(self):
        log("INFO", "Iniciando descarga de indicadores de Banxico...")
        
        indicators = []
        
        # 1. Tipo de cambio FIX
        fix_data = self.fetch_json('https://www.banxico.org.mx/canales/singleFix.json')
        if fix_data and "valor" in fix_data:
            val = fix_data["valor"]
            date_iso = self.parse_banxico_date(fix_data["fecha"])
            indicators.append({
                "id": "BM-TC-FIX",
                "title": f"Tipo de Cambio FIX Oficial Banxico: ${val} MXN",
                "summary": f"El Banco de México publica el tipo de cambio oficial (FIX) para solventar obligaciones denominadas en moneda extranjera pagaderas en la República Mexicana, cotizando hoy en {val} pesos por dólar.",
                "published_at": date_iso,
                "source_url": "https://www.banxico.org.mx",
                "source_type": "banxico",
                "source_title": "Tipo de Cambio FIX - Banco de México",
                "verified": True,
                "trust_score": 100,
                "links": [
                    {
                        "tipo": "banxico",
                        "label": "Ver en Banxico",
                        "url": "https://www.banxico.org.mx",
                        "verificado": True,
                        "es_publico": True,
                        "icono": "📈"
                    }
                ]
            })
            
        # 2. Tasa objetivo
        tasa_data = self.fetch_json('https://www.banxico.org.mx/canales/singleTasaObj.json')
        if tasa_data and "valor" in tasa_data:
            val = tasa_data["valor"]
            date_iso = self.parse_banxico_date(tasa_data["fecha"])
            indicators.append({
                "id": "BM-TASA-OBJ",
                "title": f"Tasa de Interés Objetivo de Banxico: {val}%",
                "summary": f"La tasa de referencia de política monetaria (tasa de interés interbancaria a un día) establecida por la Junta de Gobierno del Banco de México se mantiene en {val}%.",
                "published_at": date_iso,
                "source_url": "https://www.banxico.org.mx",
                "source_type": "banxico",
                "source_title": "Tasa Objetivo de Referencia - Banco de México",
                "verified": True,
                "trust_score": 100,
                "links": [
                    {
                        "tipo": "banxico",
                        "label": "Ver en Banxico",
                        "url": "https://www.banxico.org.mx",
                        "verificado": True,
                        "es_publico": True,
                        "icono": "🏛️"
                    }
                ]
            })
            
        # 3. Inflación anual
        inf_data = self.fetch_json('https://www.banxico.org.mx/canales/singleInflacion.json')
        if inf_data and "valor" in inf_data:
            val = inf_data["valor"]
            date_iso = self.parse_banxico_date(inf_data["fecha"])
            indicators.append({
                "id": "BM-INFLACION",
                "title": f"Inflación General Anualizada en México: {val}%",
                "summary": f"El Banco de México reporta que la inflación general anualizada se ubica en {val}% según el último dato oficial de la variación anual del Índice Nacional de Precios al Consumidor (INPC).",
                "published_at": date_iso,
                "source_url": "https://www.banxico.org.mx",
                "source_type": "banxico",
                "source_title": "Inflación Mensual General - Banco de México",
                "verified": True,
                "trust_score": 100,
                "links": [
                    {
                        "tipo": "banxico",
                        "label": "Ver en Banxico",
                        "url": "https://www.banxico.org.mx",
                        "verificado": True,
                        "es_publico": True,
                        "icono": "📊"
                    }
                ]
            })
            
        # Clasificar y evaluar cada indicador
        final_items = []
        for ind in indicators:
            evaluated = self.evaluate_item(ind)
            if evaluated:
                final_items.append(evaluated)
                
        return final_items

def save_feed(items, output_path):
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        log("INFO", f"Feed Banxico guardado con éxito en: {output_path} ({len(items)} ítems)")
    except Exception as e:
        log("ERROR", f"No se pudo guardar el archivo de salida en {output_path}: {e}")

if __name__ == "__main__":
    scraper = BanxicoAPI()
    items = scraper.run()
    save_feed(items, OUTPUT_PATH)
