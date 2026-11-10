import os
import sys
import csv
import json
import re
import random
import argparse
import urllib.request

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
CURATED_PATH = os.path.join(DATA_DIR, 'curated.json')
MOVIES_DATA_PATH = os.path.join(DATA_DIR, 'movies_data.json')
POSTERS_PATH = os.path.join(DATA_DIR, 'posters.json')
TRAILERS_PATH = os.path.join(DATA_DIR, 'trailers.json')
INDEX_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')

def fetch_poster(const):
    if not const:
        return ''
    try:
        url = f'https://v2.sg.media-imdb.com/suggests/{const[0].lower()}/{const}.json'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            text = resp.read().decode('utf-8', errors='ignore')
        m = re.search(r'\((\{.*\})\)', text)
        if m:
            payload = json.loads(m.group(1))
            for item in payload.get('d', []):
                if item.get('id') == const and item.get('i'):
                    raw_url = item['i'][0]
                    if raw_url.endswith('._V1_.jpg'):
                        return raw_url[:-9] + '._V1_QL75_UX380_CR0,0,380,562_.jpg'
                    return raw_url
    except Exception:
        pass
    return ''

def fetch_movie_meta(const):
    meta = {
        'Position': '',
        'Const': const,
        'Created': '',
        'Modified': '',
        'Description': '',
        'Title': const,
        'Original Title': '',
        'URL': f'https://www.imdb.com/title/{const}/',
        'Title Type': 'Movie',
        'IMDb Rating': '',
        'Runtime (mins)': '',
        'Year': '',
        'Genres': '',
        'Num Votes': '',
        'Release Date': '',
        'Directors': '',
        'Your Rating': '',
        'Date Rated': '',
        'Poster': ''
    }
    try:
        url = f'https://v2.sg.media-imdb.com/suggests/{const[0].lower()}/{const}.json'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            text = resp.read().decode('utf-8', errors='ignore')
        m = re.search(r'\((\{.*\})\)', text)
        if m:
            payload = json.loads(m.group(1))
            for item in payload.get('d', []):
                if item.get('id') == const:
                    meta['Title'] = item.get('l', const)
                    meta['Year'] = str(item.get('y', ''))
                    if item.get('s'):
                        meta['Directors'] = item.get('s')
                    if item.get('i'):
                        raw_url = item['i'][0]
                        if raw_url.endswith('._V1_.jpg'):
                            meta['Poster'] = raw_url[:-9] + '._V1_QL75_UX380_CR0,0,380,562_.jpg'
                        else:
                            meta['Poster'] = raw_url
                    break
    except Exception:
        pass
    return meta

def load_csv(csv_path):
    movies = []
    encodings = ['utf-8', 'utf-8-sig', 'cp1252', 'latin-1']
    for enc in encodings:
        try:
            with open(csv_path, 'r', encoding=enc) as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get('Const'):
                        cleaned = {k.strip(): (v.strip() if v else '') for k, v in row.items() if k}
                        movies.append(cleaned)
            return movies
        except UnicodeDecodeError:
            continue
    return movies

def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return default
    return default

def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def update_index_html(html_path, data):
    if not os.path.exists(html_path):
        return
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    fav_json = json.dumps(data['favorites'], ensure_ascii=False)
    towatch_json = json.dumps(data['to_watch'], ensure_ascii=False)
    waiting_json = json.dumps(data['waiting'], ensure_ascii=False)
    all_json = json.dumps(data['all'], ensure_ascii=False)

    content = re.sub(r'let favoriteMovies\s*=\s*\[.*?\];', f'let favoriteMovies = {fav_json};', content, flags=re.DOTALL)
    content = re.sub(r'let toWatchMovies\s*=\s*\[.*?\];', f'let toWatchMovies = {towatch_json};', content, flags=re.DOTALL)
    content = re.sub(r'let waitingMovies\s*=\s*\[.*?\];', f'let waitingMovies = {waiting_json};', content, flags=re.DOTALL)
    content = re.sub(r'let allMovies\s*=\s*\[.*?\];', f'let allMovies = {all_json};', content, flags=re.DOTALL)
    content = re.sub(r'id="badge-all">\d+<', f'id="badge-all">{len(data["all"])}<', content)
    content = re.sub(r'id="metric-all">\d+<', f'id="metric-all">{len(data["all"])}<', content)

    trailers_map = load_json(TRAILERS_PATH, {})
    trailers_json = json.dumps(trailers_map, ensure_ascii=False)
    content = re.sub(r'const trailersData\s*=\s*\{.*?\};', f'const trailersData = {trailers_json};', content, flags=re.DOTALL)

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    parser = argparse.ArgumentParser(description='Synchronize Cinema Archive with IMDb Watchlist')
    parser.add_argument('--csv', help='Path to exported IMDb Watchlist CSV file')
    parser.add_argument('--ids', help='Comma-separated IMDb Const IDs')
    parser.add_argument('--add', help='Add a single IMDb Const to collection (e.g. tt1234567)')
    parser.add_argument('--add-towatch', help='Add IMDb Const to Ready to Watch')
    parser.add_argument('--add-comingsoon', help='Add IMDb Const to Coming Soon')
    parser.add_argument('--add-fav', help='Add IMDb Const to Favorites')
    parser.add_argument('--random', action='store_true', help='Pick random film from Ready to Watch')
    args = parser.parse_args()

    curated = load_json(CURATED_PATH, {'favorites': [], 'top10_to_watch': [], 'awaiting_digital': []})
    posters = load_json(POSTERS_PATH, {})
    existing_data = load_json(MOVIES_DATA_PATH, {'favorites': [], 'to_watch': [], 'waiting': [], 'all': []})

    if args.random:
        to_watch_list = existing_data.get('to_watch', [])
        if not to_watch_list:
            print('No films in Ready to Watch.')
            return
        picked = random.choice(to_watch_list)
        print('Random pick from Ready to Watch:')
        print(f"Title: {picked.get('Title')} ({picked.get('Year', '')})")
        if picked.get('Directors'):
            print(f"Director: {picked.get('Directors')}")
        if picked.get('IMDb Rating'):
            print(f"IMDb Rating: * {picked.get('IMDb Rating')}")
        print(f"IMDb: {picked.get('URL')}")
        return

    csv_candidate = args.csv
    if not csv_candidate:
        search_locations = [
            os.path.join(DATA_DIR, 'WATCHLIST.csv'),
            os.path.join(DATA_DIR, 'watchlist.csv'),
            'WATCHLIST.csv',
            'watchlist.csv'
        ]
        for loc in search_locations:
            if os.path.exists(loc):
                csv_candidate = loc
                break

    all_movies_map = {}
    for m in existing_data.get('all', []):
        const = m.get('Const')
        if const:
            all_movies_map[const] = m

    provided_ids = []
    if args.ids:
        provided_ids = [c.strip() for c in args.ids.split(',') if c.strip().startswith('tt')]
        if provided_ids:
            all_movies_map = {c: all_movies_map[c] for c in provided_ids if c in all_movies_map}
            for c in provided_ids:
                if c not in all_movies_map:
                    print(f'Fetching metadata for {c}')
                    all_movies_map[c] = fetch_movie_meta(c)
    elif csv_candidate and os.path.exists(csv_candidate):
        csv_movies = load_csv(csv_candidate)
        print(f'Importing {len(csv_movies)} movies from {csv_candidate}')
        for m in csv_movies:
            const = m.get('Const')
            if not const:
                continue
            if const in all_movies_map:
                existing_poster = all_movies_map[const].get('Poster', '')
                all_movies_map[const].update(m)
                if not all_movies_map[const].get('Poster') and existing_poster:
                    all_movies_map[const]['Poster'] = existing_poster
            else:
                all_movies_map[const] = m

    manual_consts = []
    if args.add:
        manual_consts.append((args.add.strip(), 'all'))
    if args.add_towatch:
        c = args.add_towatch.strip()
        manual_consts.append((c, 'towatch'))
        if c not in curated.get('top10_to_watch', []):
            curated.setdefault('top10_to_watch', []).append(c)
    if args.add_comingsoon:
        c = args.add_comingsoon.strip()
        manual_consts.append((c, 'waiting'))
        if c not in curated.get('awaiting_digital', []):
            curated.setdefault('awaiting_digital', []).append(c)
    if args.add_fav:
        c = args.add_fav.strip()
        manual_consts.append((c, 'fav'))
        if c not in curated.get('favorites', []):
            curated.setdefault('favorites', []).append(c)

    for const, _ in manual_consts:
        if const not in all_movies_map:
            print(f'Fetching metadata for {const}')
            meta = fetch_movie_meta(const)
            all_movies_map[const] = meta

    if provided_ids:
        all_movies = [all_movies_map[c] for c in provided_ids if c in all_movies_map]
        for idx, m in enumerate(all_movies, 1):
            m['Position'] = str(idx)
    else:
        all_movies = list(all_movies_map.values())

    new_posters_count = 0
    for m in all_movies:
        const = m.get('Const')
        if not const:
            continue
        if not m.get('Poster'):
            if const in posters and posters[const]:
                m['Poster'] = posters[const]
            else:
                fetched = fetch_poster(const)
                if fetched:
                    m['Poster'] = fetched
                    posters[const] = fetched
                    new_posters_count += 1
        elif const not in posters:
            posters[const] = m['Poster']

    fav_ids = curated.get('favorites', [])
    to_watch_ids = curated.get('top10_to_watch', [])
    waiting_ids = curated.get('awaiting_digital', [])

    existing_fav_map = {m['Const']: m for m in existing_data.get('favorites', []) if m.get('Const')}
    favorites = []
    for idx, const in enumerate(fav_ids):
        item = all_movies_map.get(const) or existing_fav_map.get(const)
        if item:
            fav_item = dict(item)
            fav_item['Position'] = f'FAV {str(idx + 1).zfill(2)}'
            if not fav_item.get('Poster') and const in posters:
                fav_item['Poster'] = posters[const]
            favorites.append(fav_item)

    to_watch = []
    for const in to_watch_ids:
        item = all_movies_map.get(const)
        if item:
            to_watch.append(item)

    waiting = []
    for const in waiting_ids:
        item = all_movies_map.get(const)
        if item:
            waiting.append(item)

    if provided_ids:
        curated['top10_to_watch'] = [c for c in curated.get('top10_to_watch', []) if c in provided_ids]
        curated['awaiting_digital'] = [c for c in curated.get('awaiting_digital', []) if c in provided_ids]

    final_data = {
        'favorites': favorites,
        'to_watch': to_watch,
        'waiting': waiting,
        'all': all_movies
    }

    save_json(CURATED_PATH, curated)
    save_json(POSTERS_PATH, posters)
    save_json(MOVIES_DATA_PATH, final_data)
    update_index_html(INDEX_HTML_PATH, final_data)

    print(f'Synchronization complete:')
    print(f'- Total films in archive: {len(all_movies)}')
    print(f'- Favorites: {len(favorites)}')
    print(f'- Top 10 to watch: {len(to_watch)}')
    print(f'- Coming soon: {len(waiting)}')
    if new_posters_count > 0:
        print(f'- New posters fetched: {new_posters_count}')

if __name__ == '__main__':
    main()
