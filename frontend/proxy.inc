rewrite ^/api(/.*)$ $1 break;
proxy_pass http://$service:3000;
proxy_connect_timeout 2s;
proxy_read_timeout 5s;
