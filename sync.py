import os
import sys
import csv
import json
import re
import random
import argparse
import urllib.request
import html

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
CURATED_PATH = os.path.join(DATA_DIR, 'curated.json')
MOVIES_DATA_PATH = os.path.join(DATA_DIR, 'movies_data.json')
POSTERS_PATH = os.path.join(DATA_DIR, 'posters.json')
TRAILERS_PATH = os.path.join(DATA_DIR, 'trailers.json')
INDEX_HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')

def fetch_poster(const):
    if not const or not re.match(r'^tt\d{7,10}$', const):
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
    if not const or not re.match(r'^tt\d{7,10}$', const):
        return None
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

    suggest_title = ''
    suggest_q = ''
    suggest_year = ''
    suggest_poster = ''
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
                    suggest_title = item.get('l', '')
                    suggest_q = item.get('q', '')
                    suggest_year = str(item.get('y', ''))
                    if item.get('i'):
                        raw_url = item['i'][0]
                        if raw_url.endswith('._V1_.jpg'):
                            suggest_poster = raw_url[:-9] + '._V1_QL75_UX380_CR0,0,380,562_.jpg'
                        else:
                            suggest_poster = raw_url
                    break
    except Exception:
        pass

    if suggest_title:
        meta['Title'] = suggest_title
    if suggest_year:
        meta['Year'] = suggest_year
    if suggest_poster:
        meta['Poster'] = suggest_poster

    kinds = ['series', 'movie'] if 'tv' in suggest_q.lower() else ['movie', 'series']
    for kind in kinds:
        try:
            url = f'https://v3-cinemeta.strem.io/meta/{kind}/{const}.json'
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as r:
                d = json.loads(r.read().decode('utf-8'))
                cm = d.get('meta')
                if cm:
                    c_name = cm.get('name', '')
                    t1 = re.sub(r'[^a-z0-9]', '', (suggest_title or meta['Title']).lower())
                    t2 = re.sub(r'[^a-z0-9]', '', c_name.lower())
                    if suggest_title and t1 and t2 and not (t1 == t2 or t1 in t2 or t2 in t1):
                        continue

                    if cm.get('name'):
                        meta['Title'] = html.unescape(cm['name'])
                    if cm.get('year'):
                        meta['Year'] = str(cm['year'])
                    if cm.get('imdbRating'):
                        meta['IMDb Rating'] = str(cm['imdbRating'])
                    if cm.get('runtime'):
                        m_rt = re.search(r'(\d+)', str(cm['runtime']))
                        if m_rt:
                            meta['Runtime (mins)'] = m_rt.group(1)
                    if cm.get('genres') and isinstance(cm['genres'], list):
                        meta['Genres'] = html.unescape(', '.join(cm['genres']))
                    dirs = cm.get('director')
                    if dirs and isinstance(dirs, list) and len(dirs) > 0:
                        meta['Directors'] = html.unescape(', '.join(dirs))
                    elif cm.get('writer') and isinstance(cm['writer'], list) and len(cm['writer']) > 0:
                        meta['Directors'] = html.unescape(', '.join(cm['writer']))
                    if not meta['Poster'] and cm.get('poster'):
                        meta['Poster'] = cm['poster']
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

def safe_json_dumps(obj):
    return json.dumps(obj, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e')

def parse_valid_ratings(raw):
    valid = {}
    if not isinstance(raw, dict):
        return valid
    for k, v in raw.items():
        if isinstance(k, str) and re.match(r'^tt\d{7,10}$', k):
            s = str(v).strip()
            if s.isdigit() and 1 <= int(s) <= 10:
                valid[k] = str(int(s))
    return valid

def update_index_html(html_path, data):
    if not os.path.exists(html_path):
        return
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    fav_json = safe_json_dumps(data['favorites'])
    towatch_json = safe_json_dumps(data['to_watch'])
    waiting_json = safe_json_dumps(data['waiting'])
    all_json = safe_json_dumps(data['all'])
    watched_ids_json = safe_json_dumps(data.get('watched_ids', []))
    watched_arch_json = safe_json_dumps(data.get('watched_archive', []))
    ratings_json = safe_json_dumps(data.get('ratings', {}))
    cinema_pick_json = safe_json_dumps(data.get('cinema_pick', ''))

    content = re.sub(r'let favoriteMovies\s*=\s*\[.*?\];', lambda _: f'let favoriteMovies = {fav_json};', content, flags=re.DOTALL)
    content = re.sub(r'let toWatchMovies\s*=\s*\[.*?\];', lambda _: f'let toWatchMovies = {towatch_json};', content, flags=re.DOTALL)
    content = re.sub(r'let waitingMovies\s*=\s*\[.*?\];', lambda _: f'let waitingMovies = {waiting_json};', content, flags=re.DOTALL)
    content = re.sub(r'let allMovies\s*=\s*\[.*?\];', lambda _: f'let allMovies = {all_json};', content, flags=re.DOTALL)
    content = re.sub(r'let watchedMovies\s*=\s*\[.*?\];', lambda _: f'let watchedMovies = {watched_ids_json};', content, flags=re.DOTALL)
    if 'let watchedArchive' in content:
        content = re.sub(r'let watchedArchive\s*=\s*\[.*?\];', lambda _: f'let watchedArchive = {watched_arch_json};', content, flags=re.DOTALL)
    else:
        content = re.sub(r'let watchedMovies\s*=\s*\[.*?\];', lambda _: f'let watchedMovies = {watched_ids_json};\n  let watchedArchive = {watched_arch_json};', content)
    if 'let userRatings' in content:
        content = re.sub(r'let userRatings\s*=\s*\{.*?\};', lambda _: f'let userRatings = {ratings_json};', content, flags=re.DOTALL)
    else:
        content = re.sub(r'let watchedArchive\s*=\s*\[.*?\];', lambda _: f'let watchedArchive = {watched_arch_json};\n  let userRatings = {ratings_json};', content)
    if 'let cinemaPickConst' in content:
        content = re.sub(r'let cinemaPickConst\s*=\s*".*?";', lambda _: f'let cinemaPickConst = {cinema_pick_json};', content)
    else:
        content = re.sub(r'let userRatings\s*=\s*\{.*?\};', lambda _: f'let userRatings = {ratings_json};\n  let cinemaPickConst = {cinema_pick_json};', content, flags=re.DOTALL)

    content = re.sub(r'id="badge-all">\d+<', f'id="badge-all">{len(data["all"])}<', content)
    content = re.sub(r'id="metric-all">\d+<', f'id="metric-all">{len(data["all"])}<', content)
    content = re.sub(r'id="badge-favorites">\d+<', f'id="badge-favorites">{len(data["favorites"])}<', content)
    content = re.sub(r'id="metric-favorites">\d+<', f'id="metric-favorites">{len(data["favorites"])}<', content)
    content = re.sub(r'id="badge-towatch">\d+<', f'id="badge-towatch">{len(data["to_watch"])}<', content)
    content = re.sub(r'id="metric-towatch">\d+<', f'id="metric-towatch">{len(data["to_watch"])}<', content)
    content = re.sub(r'id="badge-waiting">\d+<', f'id="badge-waiting">{len(data["waiting"])}<', content)
    content = re.sub(r'id="metric-waiting">\d+<', f'id="metric-waiting">{len(data["waiting"])}<', content)
    content = re.sub(r'id="badge-watched">\d+<', f'id="badge-watched">{len(data.get("watched_ids", []))}<', content)
    content = re.sub(r'id="metric-watched">\d+<', f'id="metric-watched">{len(data.get("watched_ids", []))}<', content)

    trailers_map = load_json(TRAILERS_PATH, {})
    trailers_json = safe_json_dumps(trailers_map)
    content = re.sub(r'const trailersData\s*=\s*\{.*?\};', lambda _: f'const trailersData = {trailers_json};', content, flags=re.DOTALL)

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    parser = argparse.ArgumentParser(description='Synchronize Cinema Archive with IMDb')
    parser.add_argument('--csv', help='Path to exported IMDb Watchlist CSV file')
    parser.add_argument('--ids', help='Comma-separated IMDb Const IDs for Watchlist')
    parser.add_argument('--watched-ids', help='Comma-separated IMDb Const IDs for Watched')
    parser.add_argument('--curated-json', help='JSON string with curated lists')
    parser.add_argument('--ratings-json', help='JSON map of IMDb Const ID to user rating')
    parser.add_argument('--replace-ratings', action='store_true', help='Replace watched and ratings lists completely')
    parser.add_argument('--add', help='Add a single IMDb Const to collection (e.g. tt1234567)')
    parser.add_argument('--add-towatch', help='Add IMDb Const to Ready to Watch')
    parser.add_argument('--add-comingsoon', help='Add IMDb Const to Coming Soon')
    parser.add_argument('--add-fav', help='Add IMDb Const to Favorites')
    parser.add_argument('--random', action='store_true', help='Pick random film from Ready to Watch')
    args = parser.parse_args()

    curated = load_json(CURATED_PATH, {'favorites': [], 'top10_to_watch': [], 'awaiting_digital': [], 'watched': [], 'ratings': {}, 'cinema_pick': ''})
    if 'ratings' not in curated or not isinstance(curated['ratings'], dict):
        curated['ratings'] = {}
    if 'cinema_pick' not in curated or not isinstance(curated['cinema_pick'], str):
        curated['cinema_pick'] = ''
    posters = load_json(POSTERS_PATH, {})
    existing_data = load_json(MOVIES_DATA_PATH, {'favorites': [], 'to_watch': [], 'waiting': [], 'watched_ids': [], 'watched_archive': [], 'ratings': {}, 'all': []})

    env_ids = os.environ.get('INPUT_IDS', '').strip()
    env_watched_ids = os.environ.get('INPUT_WATCHED_IDS', '').strip()
    env_curated_json = os.environ.get('INPUT_CURATED_JSON', '').strip()
    env_ratings_json = os.environ.get('INPUT_RATINGS_JSON', '').strip()
    replace_ratings = args.replace_ratings or (os.environ.get('INPUT_REPLACE_RATINGS', '').strip().lower() == 'true')

    curated_has_ratings = False
    curated_input = args.curated_json or env_curated_json
    if curated_input:
        try:
            parsed = json.loads(curated_input)
            if 'favorites' in parsed and isinstance(parsed['favorites'], list):
                curated['favorites'] = [c for c in parsed['favorites'] if isinstance(c, str) and re.match(r'^tt\d{7,10}$', c)]
            if 'top10_to_watch' in parsed or 'to_watch' in parsed:
                raw_tw = parsed.get('top10_to_watch') or parsed.get('to_watch', [])
                if isinstance(raw_tw, list):
                    curated['top10_to_watch'] = [c for c in raw_tw if isinstance(c, str) and re.match(r'^tt\d{7,10}$', c)]
            if 'awaiting_digital' in parsed or 'waiting' in parsed:
                raw_w = parsed.get('awaiting_digital') or parsed.get('waiting', [])
                if isinstance(raw_w, list):
                    curated['awaiting_digital'] = [c for c in raw_w if isinstance(c, str) and re.match(r'^tt\d{7,10}$', c)]
            if 'watched' in parsed and isinstance(parsed['watched'], list):
                curated['watched'] = [c for c in parsed['watched'] if isinstance(c, str) and re.match(r'^tt\d{7,10}$', c)]
            if 'ratings' in parsed and isinstance(parsed['ratings'], dict):
                curated['ratings'] = parse_valid_ratings(parsed['ratings'])
                curated_has_ratings = True
            if 'cinema_pick' in parsed:
                raw_pick = parsed.get('cinema_pick')
                curated['cinema_pick'] = raw_pick.strip() if isinstance(raw_pick, str) and re.match(r'^tt\d{7,10}$', raw_pick.strip()) else ''
        except Exception as e:
            print(f'Error parsing curated JSON: {e}')

    watched_input = args.watched_ids or env_watched_ids
    if watched_input:
        parsed_w = [c.strip() for c in watched_input.split(',') if re.match(r'^tt\d{7,10}$', c.strip())]
        if parsed_w:
            if replace_ratings:
                curated['watched'] = list(dict.fromkeys(parsed_w))
            else:
                existing_w = curated.get('watched', [])
                curated['watched'] = list(dict.fromkeys(parsed_w + existing_w))

    ratings_input = args.ratings_json or env_ratings_json
    if ratings_input:
        try:
            parsed_r = parse_valid_ratings(json.loads(ratings_input))
            if parsed_r:
                if replace_ratings:
                    curated['ratings'] = parsed_r
                    curated_has_ratings = True
                else:
                    curated['ratings'].update(parsed_r)
                for k in parsed_r:
                    if k not in curated.get('watched', []):
                        curated.setdefault('watched', []).append(k)
        except Exception as e:
            print(f'Error parsing ratings JSON: {e}')

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

    for m in existing_data.get('favorites', []):
        const = m.get('Const')
        if const and const not in all_movies_map:
            all_movies_map[const] = m

    for m in existing_data.get('watched_archive', []):
        const = m.get('Const')
        if const and const not in all_movies_map:
            all_movies_map[const] = m

    for m in existing_data.get('to_watch', []):
        const = m.get('Const')
        if const and const not in all_movies_map:
            all_movies_map[const] = m

    for m in existing_data.get('waiting', []):
        const = m.get('Const')
        if const and const not in all_movies_map:
            all_movies_map[const] = m

    preserved_movies_map = dict(all_movies_map)

    raw_ids = args.ids or env_ids
    provided_ids = []
    if raw_ids:
        provided_ids = [c.strip() for c in raw_ids.split(',') if re.match(r'^tt\d{7,10}$', c.strip())]
        if provided_ids:
            all_movies_map = {c: all_movies_map[c] for c in provided_ids if c in all_movies_map}
            for c in provided_ids:
                if c not in all_movies_map:
                    print(f'Fetching metadata for {c}')
                    meta = fetch_movie_meta(c)
                    if meta:
                        all_movies_map[c] = meta
    elif csv_candidate and os.path.exists(csv_candidate):
        csv_movies = load_csv(csv_candidate)
        print(f'Importing {len(csv_movies)} movies from {csv_candidate}')
        for m in csv_movies:
            const = m.get('Const')
            if not const or not re.match(r'^tt\d{7,10}$', const):
                continue
            if const in all_movies_map:
                existing_poster = all_movies_map[const].get('Poster', '')
                all_movies_map[const].update(m)
                if not all_movies_map[const].get('Poster') and existing_poster:
                    all_movies_map[const]['Poster'] = existing_poster
            else:
                all_movies_map[const] = m

    manual_consts = []
    if args.add and re.match(r'^tt\d{7,10}$', args.add.strip()):
        manual_consts.append((args.add.strip(), 'all'))
    if args.add_towatch and re.match(r'^tt\d{7,10}$', args.add_towatch.strip()):
        c = args.add_towatch.strip()
        manual_consts.append((c, 'towatch'))
        if c not in curated.get('top10_to_watch', []):
            curated.setdefault('top10_to_watch', []).append(c)
    if args.add_comingsoon and re.match(r'^tt\d{7,10}$', args.add_comingsoon.strip()):
        c = args.add_comingsoon.strip()
        manual_consts.append((c, 'waiting'))
        if c not in curated.get('awaiting_digital', []):
            curated.setdefault('awaiting_digital', []).append(c)
    if args.add_fav and re.match(r'^tt\d{7,10}$', args.add_fav.strip()):
        c = args.add_fav.strip()
        manual_consts.append((c, 'fav'))
        if c not in curated.get('favorites', []):
            curated.setdefault('favorites', []).append(c)

    for const, _ in manual_consts:
        if const not in all_movies_map:
            print(f'Fetching metadata for {const}')
            meta = fetch_movie_meta(const)
            if meta:
                all_movies_map[const] = meta

    for c in curated.get('watched', []):
        if c not in all_movies_map:
            print(f'Fetching metadata for watched film {c}')
            meta = fetch_movie_meta(c)
            if meta:
                all_movies_map[c] = meta

    for c in curated.get('favorites', []):
        if c not in all_movies_map:
            print(f'Fetching metadata for favorite film {c}')
            meta = fetch_movie_meta(c)
            if meta:
                all_movies_map[c] = meta

    for c in curated.get('ratings', {}):
        if c not in all_movies_map:
            print(f'Fetching metadata for rated film {c}')
            meta = fetch_movie_meta(c)
            if meta:
                all_movies_map[c] = meta

    ratings_map = curated.get('ratings', {})
    for m in all_movies_map.values():
        const = m.get('Const')
        if not const:
            continue
        if const in ratings_map:
            m['Your Rating'] = ratings_map[const]
        elif curated_has_ratings:
            m['Your Rating'] = ''

    watched_set = set(curated.get('watched', []))

    if provided_ids:
        all_movies = [all_movies_map[c] for c in provided_ids if c in all_movies_map and c not in watched_set]
    else:
        all_movies = [m for m in existing_data.get('all', []) if m.get('Const') in all_movies_map and m.get('Const') not in watched_set]
        if not all_movies and not existing_data.get('all'):
            all_movies = [m for m in all_movies_map.values() if m.get('Const') not in watched_set]

    for idx, m in enumerate(all_movies, 1):
        m['Position'] = str(idx)

    new_posters_count = 0
    for m in all_movies_map.values():
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

    all_const_set = set(m['Const'] for m in all_movies if m.get('Const'))

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
    waiting = []
    for id_list, target_list in ((to_watch_ids, to_watch), (waiting_ids, waiting)):
        for const in id_list:
            item = all_movies_map.get(const) or preserved_movies_map.get(const)
            if not item:
                print(f'Fetching metadata for curated film {const}')
                item = fetch_movie_meta(const)
            if item:
                curated_item = dict(item)
                if const in ratings_map:
                    curated_item['Your Rating'] = ratings_map[const]
                elif curated_has_ratings:
                    curated_item['Your Rating'] = ''
                if not curated_item.get('Poster') and const in posters:
                    curated_item['Poster'] = posters[const]
                target_list.append(curated_item)

    fav_const_set = set(m['Const'] for m in favorites if m.get('Const'))
    watched_archive = []
    for c in curated.get('watched', []):
        if c not in all_const_set and c not in fav_const_set and c in all_movies_map:
            arch_item = dict(all_movies_map[c])
            arch_item['Position'] = ''
            watched_archive.append(arch_item)

    to_watch_const_set = set(m['Const'] for m in to_watch if m.get('Const'))
    current_pick = curated.get('cinema_pick', '')
    if not isinstance(current_pick, str) or not re.match(r'^tt\d{7,10}$', current_pick):
        current_pick = ''
    if current_pick in watched_set or current_pick not in to_watch_const_set:
        current_pick = ''
    curated['cinema_pick'] = current_pick

    final_data = {
        'favorites': favorites,
        'to_watch': to_watch,
        'waiting': waiting,
        'watched_ids': curated.get('watched', []),
        'watched_archive': watched_archive,
        'ratings': ratings_map,
        'cinema_pick': current_pick,
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
    print(f'- Watched films total: {len(curated.get("watched", []))}')
    print(f'- User ratings total: {len(ratings_map)}')
    if new_posters_count > 0:
        print(f'- New posters fetched: {new_posters_count}')

if __name__ == '__main__':
    main()
