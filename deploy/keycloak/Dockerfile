# Identity broker image: Keycloak built for PostgreSQL with the platform and demo realms baked in.
# Realm files use ${TOS_DEMO_PASSWORD} and ${TOS_EDI_PARTNER_SECRET}, resolved from the environment at import.
FROM quay.io/keycloak/keycloak:26.4 AS builder
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.4
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY realms/ /opt/keycloak/data/import/
ENV KC_DB=postgres
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
