defmodule Arbitraze.Repo do
  use Ecto.Repo,
    otp_app: :arbitraze,
    adapter: Ecto.Adapters.Postgres
end
