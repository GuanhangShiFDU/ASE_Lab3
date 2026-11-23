import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export function createRouteMap(container, status, attribution) {
  const map = L.map(container, { attributionControl: false, preferCanvas: true, scrollWheelZoom: false })
    .setView([31.23, 121.47], 12);
  const points = L.layerGroup().addTo(map);
  const disabled = new URLSearchParams(location.search).get('tiles') === 'off';
  const configured = import.meta.env.VITE_MAP_TILE_URL ?? 'osm';
  const tiles = configured === 'osm' ? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' : configured;
  let layer;
  let timer;
  let ready = false;
  function offline() {
    clearTimeout(timer);
    if (layer) {
      layer.remove();
      layer = null;
    }
    ready = false;
    status.textContent = '示意模式 · 底图不可用';
    attribution.hidden = true;
  }
  if (disabled || tiles === 'off' || tiles === '') {
    offline();
  } else {
    status.textContent = '正在加载底图';
    attribution.hidden = configured !== 'osm';
    layer = L.tileLayer(tiles, { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin' });
    layer.on('loading', () => {
      ready = false;
      clearTimeout(timer);
      timer = setTimeout(offline, 6500);
    });
    layer.on('tileload', () => {
      ready = true;
      status.textContent = '上海';
    });
    layer.on('load', () => {
      clearTimeout(timer);
      if (!ready) queueMicrotask(() => { if (!ready) offline(); });
    });
    timer = setTimeout(offline, 6500);
    layer.addTo(map);
  }

  let lastRoute;
  return (pickup, dropoff) => {
    map.invalidateSize(false);
    const coordinates = [pickup, dropoff].map(place => place && [place.latitude, place.longitude]);
    const signature = JSON.stringify(coordinates);
    if (signature === lastRoute) return;
    lastRoute = signature;
    points.clearLayers();
    coordinates.forEach((latLng, index) => {
      if (!latLng) return;
      const icon = L.divIcon({
        className: index === 0 ? 'pin pickup-pin' : 'pin dropoff-pin',
        html: index === 0 ? '起' : '终', iconSize: [29, 29], iconAnchor: [14, 14],
      });
      L.marker(latLng, { icon, title: index === 0 ? '上车点' : '目的地' }).addTo(points);
    });
    if (coordinates.every(Boolean)) {
      L.polyline(coordinates, { color: '#166663', weight: 3, dashArray: '7 7' }).addTo(points);
      map.fitBounds(coordinates, { padding: [38, 38], maxZoom: 14 });
    } else if (coordinates.some(Boolean)) {
      map.setView(coordinates.find(Boolean), 13);
    } else {
      map.setView([31.23, 121.47], 12);
    }
  };
}
