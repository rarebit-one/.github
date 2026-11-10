module example.com/svc

go 1.26

require (
	github.com/rarebit-one/void-which-binds-go v0.28.1
	github.com/prometheus/client_golang v1.24.1
	modernc.org/sqlite v1.61.1 // indirect
)

require github.com/elastic/thing v1.0.0

replace example.com/local => ../local
