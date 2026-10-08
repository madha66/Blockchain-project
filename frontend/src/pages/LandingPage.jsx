import React from 'react';
import Navbar from '../components/landing/Navbar';
import Hero from '../components/landing/Hero';
import FeaturesSection from '../components/landing/FeaturesSection';
import TransparencySection from '../components/landing/TransparencySection';
import LendPoolSection from '../components/landing/LendPoolSection';
import HowItWorks from '../components/landing/HowItWorks';
import FAQ from '../components/landing/FAQ';
import SubscribeSection from '../components/landing/SubscribeSection';
import Footer from '../components/landing/Footer';

const LandingPage = ({ wallet }) => {
  return (
    <div className="landing-page">
      <Navbar wallet={wallet} />
      <Hero wallet={wallet} />
      <FeaturesSection />
      <TransparencySection />
      <LendPoolSection />
      <HowItWorks />
      <FAQ />
      <SubscribeSection />
      <Footer />
    </div>
  );
};

export default LandingPage;
